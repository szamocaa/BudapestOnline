#include "Transit/GtfsStaticReader.h"

#include <cmath>
#include <cstring>

namespace GtfsStatic
{
namespace
{
	// Own helpers instead of std::min/std::max: Windows headers may define min/max as macros.
	inline double Smaller(double A, double B) { return A < B ? A : B; }
	inline double Larger(double A, double B) { return A > B ? A : B; }
	inline double ClampTo(double Value, double Low, double High) { return Value < Low ? Low : (Value > High ? High : Value); }

	constexpr double RadiansPerDegree = 3.14159265358979323846 / 180.0;
	constexpr uint32_t SupportedVersion = 1;
	constexpr size_t PointBytes = 16;
	constexpr size_t MinRouteBytes = 2 + 2 + 2 + 6;
	constexpr size_t MinShapeBytes = 4 + 4 + 2 * PointBytes;
	constexpr size_t MinStopBytes = 2 + 2 + PointBytes + 2;

	class FCursor
	{
	public:
		FCursor(const uint8_t* InData, size_t InSize) : Cur(InData), End(InData + InSize) {}

		size_t Remaining() const { return static_cast<size_t>(End - Cur); }

		bool ReadU8(uint8_t& Out)
		{
			if (Remaining() < 1) return false;
			Out = *Cur++;
			return true;
		}

		bool ReadU16(uint16_t& Out)
		{
			if (Remaining() < 2) return false;
			Out = static_cast<uint16_t>(static_cast<uint32_t>(Cur[0]) | (static_cast<uint32_t>(Cur[1]) << 8));
			Cur += 2;
			return true;
		}

		bool ReadU32(uint32_t& Out)
		{
			if (Remaining() < 4) return false;
			Out = static_cast<uint32_t>(Cur[0]) | (static_cast<uint32_t>(Cur[1]) << 8) |
				(static_cast<uint32_t>(Cur[2]) << 16) | (static_cast<uint32_t>(Cur[3]) << 24);
			Cur += 4;
			return true;
		}

		bool ReadF64(double& Out)
		{
			uint32_t Low = 0;
			uint32_t High = 0;
			if (!ReadU32(Low) || !ReadU32(High)) return false;
			const uint64_t Bits = static_cast<uint64_t>(Low) | (static_cast<uint64_t>(High) << 32);
			std::memcpy(&Out, &Bits, sizeof(Out));
			return true;
		}

		bool ReadString(std::string& Out)
		{
			uint16_t Length = 0;
			if (!ReadU16(Length) || Remaining() < Length) return false;
			Out.assign(reinterpret_cast<const char*>(Cur), Length);
			Cur += Length;
			return true;
		}

		bool ReadRgb(FRgb& Out) { return ReadU8(Out.R) && ReadU8(Out.G) && ReadU8(Out.B); }

		bool ReadLatLon(FLatLon& Out)
		{
			return ReadF64(Out.Latitude) && ReadF64(Out.Longitude) && std::isfinite(Out.Latitude) && std::isfinite(Out.Longitude);
		}

		bool ReadMagic(const char (&Magic)[5])
		{
			if (Remaining() < 4 || std::memcmp(Cur, Magic, 4) != 0) return false;
			Cur += 4;
			return true;
		}

	private:
		const uint8_t* Cur;
		const uint8_t* End;
	};

	double Dot(const FVec2& A, const FVec2& B) { return A.X * B.X + A.Y * B.Y; }

	FVec2 Sub(const FVec2& A, const FVec2& B)
	{
		FVec2 Out;
		Out.X = A.X - B.X;
		Out.Y = A.Y - B.Y;
		return Out;
	}

	FVec2 AddScaled(const FVec2& A, const FVec2& Direction, double Scale)
	{
		FVec2 Out;
		Out.X = A.X + Direction.X * Scale;
		Out.Y = A.Y + Direction.Y * Scale;
		return Out;
	}

	FVec2 Normalized(const FVec2& V)
	{
		const double Length = std::hypot(V.X, V.Y);
		FVec2 Out;
		if (Length > 0.0)
		{
			Out.X = V.X / Length;
			Out.Y = V.Y / Length;
		}
		return Out;
	}

	// Right of a unit direction in this frame (facing north +X, right is east +Y).
	FVec2 RightOf(const FVec2& Direction)
	{
		FVec2 Out;
		Out.X = -Direction.Y;
		Out.Y = Direction.X;
		return Out;
	}

	FVec2 DirectionFromYaw(double Yaw)
	{
		FVec2 Out;
		Out.X = std::cos(Yaw * RadiansPerDegree);
		Out.Y = std::sin(Yaw * RadiansPerDegree);
		return Out;
	}

	int64_t CellOf(double Coordinate, double Size)
	{
		// Clamped so absurd input can never overflow the conversion.
		return static_cast<int64_t>(ClampTo(std::floor(Coordinate / Size), -1e15, 1e15));
	}

	int64_t CellKey(int64_t CellX, int64_t CellY)
	{
		return static_cast<int64_t>((static_cast<uint64_t>(CellX) << 32) ^ (static_cast<uint64_t>(CellY) & 0xffffffffULL));
	}

	// Calls Visit(CellKey) for the grid cells within Pad of segment A-B. Short segments cover their
	// bounding box; long ones are sampled along their length (with the neighbouring cells) so a long
	// diagonal does not fill a huge square of cells.
	template <typename FVisit>
	void ForEachCell(const FVec2& A, const FVec2& B, double Pad, double Size, FVisit&& Visit)
	{
		const int64_t X0 = CellOf(Smaller(A.X, B.X) - Pad, Size);
		const int64_t X1 = CellOf(Larger(A.X, B.X) + Pad, Size);
		const int64_t Y0 = CellOf(Smaller(A.Y, B.Y) - Pad, Size);
		const int64_t Y1 = CellOf(Larger(A.Y, B.Y) + Pad, Size);
		if (static_cast<double>(X1 - X0 + 1) * static_cast<double>(Y1 - Y0 + 1) <= 64.0)
		{
			for (int64_t X = X0; X <= X1; ++X)
			{
				for (int64_t Y = Y0; Y <= Y1; ++Y)
				{
					Visit(CellKey(X, Y));
				}
			}
			return;
		}

		const double Step = Size * 0.5;
		const int64_t Samples = static_cast<int64_t>(ClampTo(std::hypot(B.X - A.X, B.Y - A.Y) / Step, 1.0, 1e7)) + 1;
		const int64_t Reach = 1 + static_cast<int64_t>(ClampTo(Pad / Size, 0.0, 8.0));
		for (int64_t Sample = 0; Sample <= Samples; ++Sample)
		{
			const double T = static_cast<double>(Sample) / static_cast<double>(Samples);
			const int64_t CellX = CellOf(A.X + (B.X - A.X) * T, Size);
			const int64_t CellY = CellOf(A.Y + (B.Y - A.Y) * T, Size);
			for (int64_t X = CellX - Reach; X <= CellX + Reach; ++X)
			{
				for (int64_t Y = CellY - Reach; Y <= CellY + Reach; ++Y)
				{
					Visit(CellKey(X, Y));
				}
			}
		}
	}

	// Distance from P to segment A-B.
	double PointSegmentDistance(const FVec2& P, const FVec2& A, const FVec2& B)
	{
		const FVec2 AB = Sub(B, A);
		const double LengthSquared = Dot(AB, AB);
		const double T = LengthSquared > 0.0 ? ClampTo(Dot(Sub(P, A), AB) / LengthSquared, 0.0, 1.0) : 0.0;
		const FVec2 Closest = AddScaled(A, AB, T);
		return std::hypot(P.X - Closest.X, P.Y - Closest.Y);
	}

	void PushVertex(CityMesh::FBuffer& Out, double X, double Y, double Z, double NormalX, double NormalY, double NormalZ)
	{
		Out.Positions.push_back(static_cast<float>(X));
		Out.Positions.push_back(static_cast<float>(Y));
		Out.Positions.push_back(static_cast<float>(Z));
		Out.Normals.push_back(static_cast<float>(NormalX));
		Out.Normals.push_back(static_cast<float>(NormalY));
		Out.Normals.push_back(static_cast<float>(NormalZ));
	}

	void PushTriangle(CityMesh::FBuffer& Out, uint32_t A, uint32_t B, uint32_t C)
	{
		Out.Indices.push_back(A);
		Out.Indices.push_back(B);
		Out.Indices.push_back(C);
	}

	size_t Utf8Length(const std::string& Text)
	{
		size_t Count = 0;
		for (const char Byte : Text)
		{
			if ((static_cast<unsigned char>(Byte) & 0xC0u) != 0x80u) ++Count;
		}
		return Count;
	}
}

// ------------------------------------------------------------------------------------------- file

EMode ModeForRouteType(int RouteType)
{
	const int T = RouteType;
	if (T == 0 || (T >= 900 && T <= 906)) return EMode::Tram;
	if (T == 1 || (T >= 400 && T <= 404)) return EMode::Metro;
	if (T == 2 || (T >= 100 && T <= 117)) return EMode::SuburbanRail;
	if (T == 3 || (T >= 200 && T <= 209) || (T >= 700 && T <= 716)) return EMode::Bus;
	if (T == 11 || T == 800) return EMode::Trolleybus;
	if (T == 4 || T == 1000 || T == 1200) return EMode::Ferry;
	return EMode::Unknown;
}

bool ReadNetwork(const uint8_t* Data, size_t Size, FNetwork& Out)
{
	Out = FNetwork();
	if (Data == nullptr)
	{
		return false;
	}
	FCursor Cursor(Data, Size);

	uint32_t Version = 0;
	uint32_t RouteCount = 0;
	if (!Cursor.ReadMagic("BSBT") || !Cursor.ReadU32(Version) || Version != SupportedVersion || !Cursor.ReadU32(RouteCount) ||
		static_cast<size_t>(RouteCount) > Cursor.Remaining() / MinRouteBytes)
	{
		return false;
	}

	Out.Routes.resize(RouteCount);
	for (FRoute& Route : Out.Routes)
	{
		if (!Cursor.ReadString(Route.Id) || !Cursor.ReadString(Route.ShortName) || !Cursor.ReadU16(Route.RouteType) ||
			!Cursor.ReadRgb(Route.Color) || !Cursor.ReadRgb(Route.TextColor))
		{
			return false;
		}
	}

	uint32_t ShapeCount = 0;
	if (!Cursor.ReadU32(ShapeCount) || static_cast<size_t>(ShapeCount) > Cursor.Remaining() / MinShapeBytes)
	{
		return false;
	}
	Out.Shapes.resize(ShapeCount);
	for (FShape& Shape : Out.Shapes)
	{
		uint32_t PointCount = 0;
		if (!Cursor.ReadU32(Shape.RouteIndex) || Shape.RouteIndex >= RouteCount || !Cursor.ReadU32(PointCount) ||
			PointCount < 2 || static_cast<size_t>(PointCount) > Cursor.Remaining() / PointBytes)
		{
			return false;
		}
		Shape.Points.resize(PointCount);
		for (FLatLon& Point : Shape.Points)
		{
			if (!Cursor.ReadLatLon(Point)) return false;
		}
	}

	uint32_t StopCount = 0;
	if (!Cursor.ReadU32(StopCount) || static_cast<size_t>(StopCount) > Cursor.Remaining() / MinStopBytes)
	{
		return false;
	}
	Out.Stops.resize(StopCount);
	for (FStop& Stop : Out.Stops)
	{
		uint16_t Served = 0;
		if (!Cursor.ReadString(Stop.Id) || !Cursor.ReadString(Stop.Name) || !Cursor.ReadLatLon(Stop.Position) ||
			!Cursor.ReadU16(Served) || static_cast<size_t>(Served) > Cursor.Remaining() / 4)
		{
			return false;
		}
		Stop.RouteIndices.resize(Served);
		for (uint32_t& RouteIndex : Stop.RouteIndices)
		{
			if (!Cursor.ReadU32(RouteIndex) || RouteIndex >= RouteCount) return false;
		}
	}
	return Cursor.Remaining() == 0;
}

// ------------------------------------------------------------------------------------------- angles

double YawOf(double DirectionX, double DirectionY)
{
	if (DirectionX == 0.0 && DirectionY == 0.0)
	{
		return 0.0;
	}
	double Yaw = std::atan2(DirectionY, DirectionX) / RadiansPerDegree;
	if (Yaw < 0.0) Yaw += 360.0;
	return Yaw >= 360.0 ? 0.0 : Yaw;
}

double YawDifference(double YawA, double YawB)
{
	const double Difference = std::fmod(std::fabs(YawA - YawB), 360.0);
	return Difference > 180.0 ? 360.0 - Difference : Difference;
}

double ContinuousYaw(double SegmentYaw, double ReferenceYaw)
{
	double Yaw = YawDifference(SegmentYaw, ReferenceYaw) <= 90.0 ? SegmentYaw : SegmentYaw + 180.0;
	Yaw = std::fmod(Yaw, 360.0);
	if (Yaw < 0.0) Yaw += 360.0;
	return Yaw >= 360.0 ? 0.0 : Yaw;
}

// ------------------------------------------------------------------------------------------- route geometry

void FRouteGeometry::Reset()
{
	Polylines.clear();
	Segments.clear();
	Grid.clear();
	CellSize = 0.0;
}

void FRouteGeometry::Measure(FPolyline& Line)
{
	Line.Cumulative.assign(Line.Points.size(), 0.0);
	for (size_t I = 1; I < Line.Points.size(); ++I)
	{
		const FVec2& A = Line.Points[I - 1];
		const FVec2& B = Line.Points[I];
		Line.Cumulative[I] = Line.Cumulative[I - 1] + std::hypot(B.X - A.X, B.Y - A.Y);
	}
}

int32_t FRouteGeometry::AddPolyline(uint32_t RouteIndex, uint8_t Layer, const std::vector<FVec2>& Points)
{
	FPolyline Line;
	Line.Route = RouteIndex;
	Line.Layer = Layer;
	Line.Points.reserve(Points.size());
	for (const FVec2& Point : Points)
	{
		if (!std::isfinite(Point.X) || !std::isfinite(Point.Y) || std::fabs(Point.X) > MaxCoordinate || std::fabs(Point.Y) > MaxCoordinate) continue;
		if (Line.Points.empty() || Line.Points.back().X != Point.X || Line.Points.back().Y != Point.Y)
		{
			Line.Points.push_back(Point);
		}
	}
	if (Line.Points.size() < 2)
	{
		return -1;
	}
	Measure(Line);
	Polylines.push_back(std::move(Line));
	return static_cast<int32_t>(Polylines.size() - 1);
}

void FRouteGeometry::SeparateSharedCenterlines(const std::vector<double>& OffsetByLayer, double DetectRadius)
{
	if (DetectRadius <= 0.0 || Polylines.empty())
	{
		return;
	}

	// Temporary grid over the original segments, cells a few times the search radius.
	const double Cell = DetectRadius * 4.0;
	std::unordered_map<int64_t, std::vector<FSegmentRef>> Nearby;
	for (size_t P = 0; P < Polylines.size(); ++P)
	{
		const std::vector<FVec2>& Points = Polylines[P].Points;
		for (size_t S = 0; S + 1 < Points.size(); ++S)
		{
			FSegmentRef Ref;
			Ref.Polyline = static_cast<int32_t>(P);
			Ref.Segment = static_cast<int32_t>(S);
			ForEachCell(Points[S], Points[S + 1], DetectRadius, Cell, [&Nearby, &Ref](int64_t Key) { Nearby[Key].push_back(Ref); });
		}
	}

	std::vector<std::vector<FVec2>> Moved(Polylines.size());
	for (size_t P = 0; P < Polylines.size(); ++P)
	{
		const FPolyline& Line = Polylines[P];
		const size_t LayerIndex = static_cast<size_t>(Line.Layer);
		const double Offset = LayerIndex < OffsetByLayer.size() ? OffsetByLayer[LayerIndex] : 0.0;
		Moved[P] = Line.Points;
		if (Offset == 0.0)
		{
			continue;
		}

		const std::vector<FVec2> Miters = RightMiters(Line.Points);
		const size_t Count = Line.Points.size();
		for (size_t I = 0; I < Count; ++I)
		{
			const FVec2& Here = Line.Points[I];
			const FVec2 Ahead = Normalized(Sub(Line.Points[I + 1 < Count ? I + 1 : I], Line.Points[I > 0 ? I - 1 : I]));

			bool bShared = false;
			const auto Found = Nearby.find(CellKey(CellOf(Here.X, Cell), CellOf(Here.Y, Cell)));
			if (Found != Nearby.end())
			{
				for (const FSegmentRef& Ref : Found->second)
				{
					const FPolyline& Other = Polylines[static_cast<size_t>(Ref.Polyline)];
					if (Other.Layer != Line.Layer) continue;
					const size_t OtherSegment = static_cast<size_t>(Ref.Segment);
					// A polyline's own segments next to this point do not count (a hairpin would always match).
					if (static_cast<size_t>(Ref.Polyline) == P && (OtherSegment + 1 == I || OtherSegment == I)) continue;
					const FVec2& A = Other.Points[OtherSegment];
					const FVec2& B = Other.Points[OtherSegment + 1];
					if (Dot(Ahead, Normalized(Sub(B, A))) < -0.7 && PointSegmentDistance(Here, A, B) <= DetectRadius)
					{
						bShared = true;
						break;
					}
				}
			}
			if (bShared)
			{
				Moved[P][I] = AddScaled(Here, Miters[I], Offset);
			}
		}
	}

	for (size_t P = 0; P < Polylines.size(); ++P)
	{
		Polylines[P].Points = std::move(Moved[P]);
		Measure(Polylines[P]);
	}
}

void FRouteGeometry::Build(double InCellSize)
{
	CellSize = InCellSize > 0.0 ? InCellSize : 5000.0;
	Segments.clear();
	Grid.clear();
	for (size_t P = 0; P < Polylines.size(); ++P)
	{
		const std::vector<FVec2>& Points = Polylines[P].Points;
		for (size_t S = 0; S + 1 < Points.size(); ++S)
		{
			FSegmentRef Ref;
			Ref.Polyline = static_cast<int32_t>(P);
			Ref.Segment = static_cast<int32_t>(S);
			const uint32_t Id = static_cast<uint32_t>(Segments.size());
			Segments.push_back(Ref);

			ForEachCell(Points[S], Points[S + 1], 0.0, CellSize, [this, Id](int64_t Key) { Grid[Key].push_back(Id); });
		}
	}
}

uint32_t FRouteGeometry::RouteOf(int32_t Polyline) const
{
	return IsValidPolyline(Polyline) ? Polylines[static_cast<size_t>(Polyline)].Route : 0u;
}

uint8_t FRouteGeometry::LayerOf(int32_t Polyline) const
{
	return IsValidPolyline(Polyline) ? Polylines[static_cast<size_t>(Polyline)].Layer : static_cast<uint8_t>(0);
}

const std::vector<FVec2>& FRouteGeometry::PointsOf(int32_t Polyline) const
{
	static const std::vector<FVec2> NoPoints;
	return IsValidPolyline(Polyline) ? Polylines[static_cast<size_t>(Polyline)].Points : NoPoints;
}

double FRouteGeometry::LengthOf(int32_t Polyline) const
{
	return IsValidPolyline(Polyline) ? Polylines[static_cast<size_t>(Polyline)].Cumulative.back() : 0.0;
}

bool FRouteGeometry::NearestOnSegment(int32_t Polyline, int32_t Segment, const FVec2& Query, FSnap& Out) const
{
	const FPolyline& Line = Polylines[static_cast<size_t>(Polyline)];
	const size_t S = static_cast<size_t>(Segment);
	const FVec2& A = Line.Points[S];
	const FVec2& B = Line.Points[S + 1];
	const FVec2 AB = Sub(B, A);
	const double LengthSquared = Dot(AB, AB);
	if (LengthSquared <= 0.0)
	{
		return false;
	}
	const double T = ClampTo(Dot(Sub(Query, A), AB) / LengthSquared, 0.0, 1.0);
	Out.Polyline = Polyline;
	Out.Segment = Segment;
	Out.Point = AddScaled(A, AB, T);
	Out.Gap = std::hypot(Query.X - Out.Point.X, Query.Y - Out.Point.Y);
	Out.Distance = Line.Cumulative[S] + T * (Line.Cumulative[S + 1] - Line.Cumulative[S]);
	Out.Yaw = YawOf(AB.X, AB.Y);
	return true;
}

bool FRouteGeometry::Snap(uint32_t RouteIndex, const FVec2& Query, double MaxGap, bool bHasReference, double ReferenceYaw, FSnap& Out) const
{
	if (CellSize <= 0.0 || MaxGap < 0.0 || !std::isfinite(Query.X) || !std::isfinite(Query.Y))
	{
		return false;
	}

	const int64_t X0 = CellOf(Query.X - MaxGap, CellSize);
	const int64_t X1 = CellOf(Query.X + MaxGap, CellSize);
	const int64_t Y0 = CellOf(Query.Y - MaxGap, CellSize);
	const int64_t Y1 = CellOf(Query.Y + MaxGap, CellSize);
	if (static_cast<double>(X1 - X0 + 1) * static_cast<double>(Y1 - Y0 + 1) > 4096.0)
	{
		return false; // absurd search radius
	}

	const FVec2 Reference = DirectionFromYaw(ReferenceYaw);
	bool bFound = false;
	double BestScore = 0.0;
	for (int64_t X = X0; X <= X1; ++X)
	{
		for (int64_t Y = Y0; Y <= Y1; ++Y)
		{
			const auto Cell = Grid.find(CellKey(X, Y));
			if (Cell == Grid.end()) continue;
			for (const uint32_t Id : Cell->second)
			{
				const FSegmentRef& Ref = Segments[Id];
				if (Polylines[static_cast<size_t>(Ref.Polyline)].Route != RouteIndex) continue;
				FSnap Candidate;
				if (!NearestOnSegment(Ref.Polyline, Ref.Segment, Query, Candidate) || Candidate.Gap > MaxGap) continue;
				double Score = Candidate.Gap;
				if (bHasReference && Dot(DirectionFromYaw(Candidate.Yaw), Reference) < 0.0)
				{
					Score += WrongWayPenalty;
				}
				if (!bFound || Score < BestScore)
				{
					bFound = true;
					BestScore = Score;
					Out = Candidate;
				}
			}
		}
	}
	return bFound;
}

bool FRouteGeometry::Project(int32_t Polyline, const FVec2& Query, FSnap& Out) const
{
	if (!IsValidPolyline(Polyline))
	{
		return false;
	}
	bool bFound = false;
	const size_t SegmentCount = Polylines[static_cast<size_t>(Polyline)].Points.size() - 1;
	for (size_t S = 0; S < SegmentCount; ++S)
	{
		FSnap Candidate;
		if (NearestOnSegment(Polyline, static_cast<int32_t>(S), Query, Candidate) && (!bFound || Candidate.Gap < Out.Gap))
		{
			bFound = true;
			Out = Candidate;
		}
	}
	return bFound;
}

FVec2 FRouteGeometry::PointAt(int32_t Polyline, double Distance, double* OutYaw) const
{
	if (!IsValidPolyline(Polyline))
	{
		if (OutYaw != nullptr) *OutYaw = 0.0;
		return FVec2();
	}
	const FPolyline& Line = Polylines[static_cast<size_t>(Polyline)];
	const std::vector<double>& Cumulative = Line.Cumulative;

	// Segment holding Distance (binary search); before the start / past the end use the first / last segment.
	size_t Low = 0;
	size_t High = Cumulative.size() - 1;
	while (High - Low > 1)
	{
		const size_t Mid = (Low + High) / 2;
		if (Cumulative[Mid] <= Distance) Low = Mid; else High = Mid;
	}
	const FVec2& A = Line.Points[Low];
	const FVec2& B = Line.Points[Low + 1];
	const double SegmentLength = Cumulative[Low + 1] - Cumulative[Low];
	const FVec2 Direction = Normalized(Sub(B, A));
	if (OutYaw != nullptr) *OutYaw = YawOf(Direction.X, Direction.Y);
	return SegmentLength > 0.0 ? AddScaled(A, Direction, Distance - Cumulative[Low]) : A;
}

// ------------------------------------------------------------------------------------------- following

void FTrackFollower::Stop()
{
	Polyline = -1;
	Speed = 0.0;
}

void FTrackFollower::Advance(double DeltaSeconds)
{
	if (Polyline < 0 || Speed <= 0.0 || DeltaSeconds <= 0.0)
	{
		return;
	}
	const double Remaining = (Target - Distance) * static_cast<double>(Direction);
	const double Step = Speed * DeltaSeconds;
	if (Step >= Remaining)
	{
		Distance = Target;
		Speed = 0.0;
	}
	else
	{
		Distance += static_cast<double>(Direction) * Step;
	}
}

EFollow UpdateFollower(const FRouteGeometry& Geometry, FTrackFollower& Follower, const FSnap& Snap,
	double TravelYaw, double SecondsToArrive, const FFollowLimits& Limits)
{
	const int32_t NewDirection = YawDifference(Snap.Yaw, TravelYaw) <= 90.0 ? 1 : -1;
	const auto JumpTo = [&Follower, &Snap, NewDirection]()
	{
		Follower.Polyline = Snap.Polyline;
		Follower.Distance = Snap.Distance;
		Follower.Target = Snap.Distance;
		Follower.Speed = 0.0;
		Follower.Direction = NewDirection;
	};

	if (!Follower.IsActive() || !Geometry.IsValidPolyline(Follower.Polyline))
	{
		JumpTo();
		return EFollow::Started;
	}

	EFollow Result = EFollow::Continued;
	if (Snap.Polyline != Follower.Polyline)
	{
		FSnap OnNew;
		if (!Geometry.Project(Snap.Polyline, Geometry.PointAt(Follower.Polyline, Follower.Distance), OnNew) || OnNew.Gap > Limits.SwitchRadius)
		{
			JumpTo();
			return EFollow::Jumped;
		}
		Follower.Polyline = Snap.Polyline;
		Follower.Distance = OnNew.Distance;
		Follower.Direction = NewDirection;
		Result = EFollow::Switched;
	}
	else if (NewDirection != Follower.Direction)
	{
		JumpTo(); // turned round on the same line (e.g. a bidirectional tram at a stub terminus)
		return EFollow::Jumped;
	}

	const double Gap = (Snap.Distance - Follower.Distance) * static_cast<double>(Follower.Direction);
	if (Gap < -Limits.MaxBackward || Gap > Limits.MaxForward)
	{
		JumpTo();
		return EFollow::Jumped;
	}
	if (Gap < 0.0)
	{
		Follower.Target = Follower.Distance;
		Follower.Speed = 0.0;
		return Result == EFollow::Switched ? EFollow::Switched : EFollow::HeldBack;
	}
	Follower.Target = Snap.Distance;
	Follower.Speed = Gap / Larger(SecondsToArrive, 0.1);
	return Result;
}

void ChordPose(const FRouteGeometry& Geometry, int32_t Polyline, double FrontDistance, double RearDistance, FVec2& OutCenter, double& OutYaw)
{
	double FrontYaw = 0.0;
	const FVec2 Front = Geometry.PointAt(Polyline, FrontDistance, &FrontYaw);
	const FVec2 Rear = Geometry.PointAt(Polyline, RearDistance);
	OutCenter.X = 0.5 * (Front.X + Rear.X);
	OutCenter.Y = 0.5 * (Front.Y + Rear.Y);
	const FVec2 Chord = Sub(Front, Rear);
	if (Dot(Chord, Chord) > 1e-12)
	{
		OutYaw = YawOf(Chord.X, Chord.Y);
	}
	else
	{
		OutYaw = FrontDistance >= RearDistance ? FrontYaw : std::fmod(FrontYaw + 180.0, 360.0);
	}
}

// ------------------------------------------------------------------------------------------- meshes

std::vector<FVec2> RightMiters(const std::vector<FVec2>& Points)
{
	const size_t Count = Points.size();
	std::vector<FVec2> Miters(Count);
	if (Count < 2)
	{
		return Miters;
	}
	std::vector<FVec2> SegmentRights(Count - 1);
	for (size_t S = 0; S + 1 < Count; ++S)
	{
		SegmentRights[S] = RightOf(Normalized(Sub(Points[S + 1], Points[S])));
	}
	Miters[0] = SegmentRights[0];
	Miters[Count - 1] = SegmentRights[Count - 2];
	for (size_t I = 1; I + 1 < Count; ++I)
	{
		const FVec2& Before = SegmentRights[I - 1];
		const FVec2& After = SegmentRights[I];
		FVec2 Sum;
		Sum.X = Before.X + After.X;
		Sum.Y = Before.Y + After.Y;
		const FVec2 Bisector = Normalized(Sum);
		const double Cosine = Dot(Bisector, After);
		if (Dot(Bisector, Bisector) == 0.0 || Cosine <= 0.0)
		{
			Miters[I] = After; // reverses on itself: no sensible miter
			continue;
		}
		// Keep the strip's width across the bend, but never more than twice it on sharp corners.
		const double Scale = 1.0 / Larger(Cosine, 0.5);
		Miters[I].X = Bisector.X * Scale;
		Miters[I].Y = Bisector.Y * Scale;
	}
	return Miters;
}

void AppendStripSegment(const std::vector<FVec2>& Points, const std::vector<FVec2>& Miters, size_t Segment,
	const FStripProfile& Profile, double OriginX, double OriginY, CityMesh::FBuffer& Out)
{
	if (Segment + 1 >= Points.size() || Miters.size() != Points.size())
	{
		return;
	}
	const FVec2& P0 = Points[Segment];
	const FVec2& P1 = Points[Segment + 1];
	const FVec2 Right = RightOf(Normalized(Sub(P1, P0)));
	if (Dot(Right, Right) == 0.0)
	{
		return;
	}
	const FVec2 L0 = AddScaled(P0, Miters[Segment], Profile.Left);
	const FVec2 R0 = AddScaled(P0, Miters[Segment], Profile.Right);
	const FVec2 L1 = AddScaled(P1, Miters[Segment + 1], Profile.Left);
	const FVec2 R1 = AddScaled(P1, Miters[Segment + 1], Profile.Right);

	// Top: (L0, R1, R0) and (L0, L1, R1) face up in this frame.
	uint32_t Base = static_cast<uint32_t>(Out.VertexCount());
	PushVertex(Out, L0.X - OriginX, L0.Y - OriginY, Profile.TopZ, 0.0, 0.0, 1.0);
	PushVertex(Out, R0.X - OriginX, R0.Y - OriginY, Profile.TopZ, 0.0, 0.0, 1.0);
	PushVertex(Out, L1.X - OriginX, L1.Y - OriginY, Profile.TopZ, 0.0, 0.0, 1.0);
	PushVertex(Out, R1.X - OriginX, R1.Y - OriginY, Profile.TopZ, 0.0, 0.0, 1.0);
	PushTriangle(Out, Base + 0, Base + 3, Base + 1);
	PushTriangle(Out, Base + 0, Base + 2, Base + 3);

	if (!Profile.bSides)
	{
		return;
	}

	// Right wall faces +Right: (R0 bottom, R0 top, R1 top), (R0 bottom, R1 top, R1 bottom).
	Base = static_cast<uint32_t>(Out.VertexCount());
	PushVertex(Out, R0.X - OriginX, R0.Y - OriginY, Profile.BottomZ, Right.X, Right.Y, 0.0);
	PushVertex(Out, R0.X - OriginX, R0.Y - OriginY, Profile.TopZ, Right.X, Right.Y, 0.0);
	PushVertex(Out, R1.X - OriginX, R1.Y - OriginY, Profile.TopZ, Right.X, Right.Y, 0.0);
	PushVertex(Out, R1.X - OriginX, R1.Y - OriginY, Profile.BottomZ, Right.X, Right.Y, 0.0);
	PushTriangle(Out, Base + 0, Base + 1, Base + 2);
	PushTriangle(Out, Base + 0, Base + 2, Base + 3);

	// Left wall faces -Right: (L0 bottom, L1 top, L0 top), (L0 bottom, L1 bottom, L1 top).
	Base = static_cast<uint32_t>(Out.VertexCount());
	PushVertex(Out, L0.X - OriginX, L0.Y - OriginY, Profile.BottomZ, -Right.X, -Right.Y, 0.0);
	PushVertex(Out, L0.X - OriginX, L0.Y - OriginY, Profile.TopZ, -Right.X, -Right.Y, 0.0);
	PushVertex(Out, L1.X - OriginX, L1.Y - OriginY, Profile.TopZ, -Right.X, -Right.Y, 0.0);
	PushVertex(Out, L1.X - OriginX, L1.Y - OriginY, Profile.BottomZ, -Right.X, -Right.Y, 0.0);
	PushTriangle(Out, Base + 0, Base + 2, Base + 1);
	PushTriangle(Out, Base + 0, Base + 3, Base + 2);
}

size_t FSegmentSet::FHash::operator()(const std::array<int64_t, 4>& Key) const
{
	uint64_t Hash = 1469598103934665603ULL;
	for (const int64_t Value : Key)
	{
		Hash ^= static_cast<uint64_t>(Value);
		Hash *= 1099511628211ULL;
		Hash ^= Hash >> 29;
	}
	return static_cast<size_t>(Hash);
}

bool FSegmentSet::Insert(const FVec2& A, const FVec2& B)
{
	const double Step = Quantum > 0.0 ? Quantum : 1.0;
	const int64_t AX = static_cast<int64_t>(std::llround(A.X / Step));
	const int64_t AY = static_cast<int64_t>(std::llround(A.Y / Step));
	const int64_t BX = static_cast<int64_t>(std::llround(B.X / Step));
	const int64_t BY = static_cast<int64_t>(std::llround(B.Y / Step));
	const bool bAFirst = AX < BX || (AX == BX && AY <= BY);
	const std::array<int64_t, 4> Key = bAFirst ? std::array<int64_t, 4>{ { AX, AY, BX, BY } } : std::array<int64_t, 4>{ { BX, BY, AX, AY } };
	return Seen.insert(Key).second;
}

// ------------------------------------------------------------------------------------------- text

std::string FoldDoubleAcute(const std::string& Utf8)
{
	std::string Out;
	Out.reserve(Utf8.size());
	for (size_t I = 0; I < Utf8.size(); ++I)
	{
		const unsigned char Lead = static_cast<unsigned char>(Utf8[I]);
		if (Lead == 0xC5u && I + 1 < Utf8.size())
		{
			const unsigned char Next = static_cast<unsigned char>(Utf8[I + 1]);
			// U+0150 O / U+0151 o / U+0170 U / U+0171 u (double acute) -> U+00D6 / U+00F6 / U+00DC / U+00FC.
			const unsigned char Replacement = Next == 0x90u ? 0x96u : Next == 0x91u ? 0xB6u : Next == 0xB0u ? 0x9Cu : Next == 0xB1u ? 0xBCu : 0u;
			if (Replacement != 0u)
			{
				Out.push_back(static_cast<char>(0xC3u));
				Out.push_back(static_cast<char>(Replacement));
				++I;
				continue;
			}
		}
		Out.push_back(Utf8[I]);
	}
	return Out;
}

std::vector<std::string> WrapWords(const std::string& Utf8, size_t MaxChars)
{
	std::vector<std::string> Lines;
	std::string Line;
	size_t LineLength = 0;
	size_t Start = 0;
	while (Start < Utf8.size())
	{
		while (Start < Utf8.size() && Utf8[Start] == ' ') ++Start;
		size_t Stop = Start;
		while (Stop < Utf8.size() && Utf8[Stop] != ' ') ++Stop;
		if (Stop == Start) break;

		const std::string Word = Utf8.substr(Start, Stop - Start);
		const size_t WordLength = Utf8Length(Word);
		if (LineLength > 0 && LineLength + 1 + WordLength > MaxChars)
		{
			Lines.push_back(Line);
			Line.clear();
			LineLength = 0;
		}
		if (LineLength > 0)
		{
			Line.push_back(' ');
			++LineLength;
		}
		Line += Word;
		LineLength += WordLength;
		Start = Stop;
	}
	if (!Line.empty())
	{
		Lines.push_back(Line);
	}
	return Lines;
}
}
