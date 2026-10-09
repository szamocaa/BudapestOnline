// Tests Transit/GtfsStaticReader: the baked transit file (written by Tools/Transit/bake_gtfs.py from
// the hand-made GTFS feed in Tools/Transit/fixtures), route types, snapping, track following,
// centreline separation, strip meshes and sign text.
#include "Transit/GtfsStaticReader.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <random>
#include <string>
#include <vector>

static int Failures = 0;
#define EXPECT(Cond, ...)                                  \
	do                                                     \
	{                                                      \
		if (!(Cond))                                       \
		{                                                  \
			std::printf("FAIL line %d: ", __LINE__);       \
			std::printf(__VA_ARGS__);                      \
			std::printf("\n");                             \
			++Failures;                                    \
		}                                                  \
	} while (0)

using GtfsStatic::FVec2;

static std::vector<uint8_t> Load(const std::string& Path)
{
	std::ifstream In(Path, std::ios::binary);
	return std::vector<uint8_t>((std::istreambuf_iterator<char>(In)), std::istreambuf_iterator<char>());
}

static FVec2 V(double X, double Y)
{
	FVec2 Out;
	Out.X = X;
	Out.Y = Y;
	return Out;
}

static bool Near(double A, double B, double Tolerance = 1e-6) { return std::fabs(A - B) <= Tolerance; }

// Same flat projection as GeoProjection.h, in centimetres, around the default origin.
static FVec2 ProjectCm(const GtfsStatic::FLatLon& P)
{
	const double Pi = 3.14159265358979323846;
	const double R = 6371008.8;
	const double OriginLat = 47.4925;
	const double OriginLon = 19.0800;
	return V((P.Latitude - OriginLat) * Pi / 180.0 * R * 100.0, (P.Longitude - OriginLon) * Pi / 180.0 * R * std::cos(OriginLat * Pi / 180.0) * 100.0);
}

static std::string Hex(const GtfsStatic::FRgb& C)
{
	char Buffer[8];
	std::snprintf(Buffer, sizeof(Buffer), "%02X%02X%02X", C.R, C.G, C.B);
	return Buffer;
}

static void TestRouteTypes()
{
	using GtfsStatic::EMode;
	struct FCase { int Type; EMode Mode; };
	const FCase Cases[] = {
		{ 0, EMode::Tram }, { 900, EMode::Tram }, { 906, EMode::Tram }, { 907, EMode::Unknown },
		{ 1, EMode::Metro }, { 400, EMode::Metro }, { 404, EMode::Metro }, { 405, EMode::Unknown },
		{ 2, EMode::SuburbanRail }, { 100, EMode::SuburbanRail }, { 109, EMode::SuburbanRail }, { 117, EMode::SuburbanRail }, { 118, EMode::Unknown },
		{ 3, EMode::Bus }, { 200, EMode::Bus }, { 209, EMode::Bus }, { 700, EMode::Bus }, { 715, EMode::Bus }, { 716, EMode::Bus }, { 717, EMode::Unknown },
		{ 11, EMode::Trolleybus }, { 800, EMode::Trolleybus }, { 801, EMode::Unknown },
		{ 4, EMode::Ferry }, { 1000, EMode::Ferry }, { 1200, EMode::Ferry },
		{ 5, EMode::Unknown }, { 7, EMode::Unknown }, { 12, EMode::Unknown }, { 1400, EMode::Unknown }, { 65535, EMode::Unknown }, { -1, EMode::Unknown },
	};
	for (const FCase& Case : Cases)
	{
		EXPECT(GtfsStatic::ModeForRouteType(Case.Type) == Case.Mode, "route_type %d -> mode %d, expected %d", Case.Type,
			static_cast<int>(GtfsStatic::ModeForRouteType(Case.Type)), static_cast<int>(Case.Mode));
	}
}

static void TestFixture(const std::vector<uint8_t>& Bytes)
{
	GtfsStatic::FNetwork Net;
	EXPECT(!Bytes.empty(), "fixture file missing or empty");
	EXPECT(GtfsStatic::ReadNetwork(Bytes.data(), Bytes.size(), Net), "fixture does not parse");

	const char* Names[] = { "4", "6", "28", "M4", "83", "9", "282E", "990", "M3 p\xC3\xB3tl\xC3\xB3" };
	const char* Ids[] = { "3040", "3060", "3280", "5400", "7830", "0090", "2820", "9990", "M3P" };
	const int Types[] = { 0, 900, 0, 1, 11, 3, 715, 3, 3 };
	const char* Colors[] = { "FFD800", "FFD800", "FFD800", "4CA22F", "FF1609", "009FE3", "009FE3", "1E1E1E", "009FE3" };
	const char* TextColors[] = { "000000", "000000", "000000", "FFFFFF", "FFFFFF", "FFFFFF", "FFFFFF", "FFFFFF", "FFFFFF" };
	EXPECT(Net.Routes.size() == 9, "%zu routes", Net.Routes.size());
	for (size_t I = 0; I < Net.Routes.size() && I < 9; ++I)
	{
		const GtfsStatic::FRoute& Route = Net.Routes[I];
		EXPECT(Route.ShortName == Names[I], "route %zu name '%s'", I, Route.ShortName.c_str());
		EXPECT(Route.Id == Ids[I], "route %zu id '%s'", I, Route.Id.c_str());
		EXPECT(Route.RouteType == Types[I], "route %zu type %d", I, Route.RouteType);
		EXPECT(Hex(Route.Color) == Colors[I], "route %zu colour %s", I, Hex(Route.Color).c_str());
		EXPECT(Hex(Route.TextColor) == TextColors[I], "route %zu text colour %s", I, Hex(Route.TextColor).c_str());
	}
	EXPECT(GtfsStatic::ModeForRouteType(Net.Routes[1].RouteType) == GtfsStatic::EMode::Tram, "extended tram type");

	// Shapes: 2 for line 4 (both directions), 1 for 6, 2 pieces for 28, 1 each for M4, 83, 9, 282E, 990.
	EXPECT(Net.Shapes.size() == 10, "%zu shapes", Net.Shapes.size());
	size_t PerRoute[9] = {};
	for (const GtfsStatic::FShape& Shape : Net.Shapes)
	{
		if (Shape.RouteIndex < 9) ++PerRoute[Shape.RouteIndex];
		EXPECT(Shape.Points.size() >= 2, "short shape");
	}
	const size_t ExpectedPerRoute[9] = { 2, 1, 2, 1, 1, 1, 1, 1, 0 };
	for (size_t I = 0; I < 9; ++I)
	{
		EXPECT(PerRoute[I] == ExpectedPerRoute[I], "route %zu has %zu shapes, expected %zu", I, PerRoute[I], ExpectedPerRoute[I]);
	}
	// The northbound line 4 piece: 9 points from 2 km south to 2 km north along 1 km west of the origin.
	bool bFoundNorth = false;
	for (const GtfsStatic::FShape& Shape : Net.Shapes)
	{
		if (Shape.RouteIndex != 0 || Shape.Points.size() != 9) continue;
		const FVec2 First = ProjectCm(Shape.Points.front());
		const FVec2 Last = ProjectCm(Shape.Points.back());
		if (First.X < Last.X)
		{
			bFoundNorth = true;
			EXPECT(Near(First.X, -200000.0, 2.0) && Near(First.Y, -100000.0, 2.0), "line 4 starts at %.1f, %.1f", First.X, First.Y);
			EXPECT(Near(Last.X, 200000.0, 2.0) && Near(Last.Y, -100000.0, 2.0), "line 4 ends at %.1f, %.1f", Last.X, Last.Y);
		}
	}
	EXPECT(bFoundNorth, "no northbound line 4 shape");

	EXPECT(Net.Stops.size() == 4, "%zu stops", Net.Stops.size());
	if (Net.Stops.size() == 4)
	{
		EXPECT(Net.Stops[0].Id == "F01000" && Net.Stops[0].Name == "Blaha Lujza t\xC3\xA9r M", "stop 0 '%s'", Net.Stops[0].Name.c_str());
		EXPECT((Net.Stops[0].RouteIndices == std::vector<uint32_t>{ 0, 1, 5 }), "stop 0 served by %zu routes", Net.Stops[0].RouteIndices.size());
		EXPECT(Net.Stops[1].Name == "Corvin-negyed M, \"Kisfaludy\" k\xC3\xB6z", "quoted stop name '%s'", Net.Stops[1].Name.c_str());
		EXPECT((Net.Stops[2].RouteIndices == std::vector<uint32_t>{ 4, 8 }), "stop 2 routes");
		const FVec2 Blaha = ProjectCm(Net.Stops[0].Position);
		EXPECT(Near(Blaha.X, 0.0, 2.0) && Near(Blaha.Y, -100000.0, 2.0), "stop 0 at %.1f, %.1f", Blaha.X, Blaha.Y);
	}

	// Every truncation must fail cleanly, and so must trailing bytes.
	for (size_t Length = 0; Length < Bytes.size(); ++Length)
	{
		GtfsStatic::FNetwork Partial;
		EXPECT(!GtfsStatic::ReadNetwork(Bytes.data(), Length, Partial), "truncated to %zu bytes but parsed", Length);
	}
	std::vector<uint8_t> Longer = Bytes;
	Longer.push_back(0);
	EXPECT(!GtfsStatic::ReadNetwork(Longer.data(), Longer.size(), Net), "trailing byte accepted");
	EXPECT(!GtfsStatic::ReadNetwork(nullptr, 0, Net), "null data accepted");

	// Wrong version, absurd counts and out-of-range route indices are refused.
	std::vector<uint8_t> Bad = Bytes;
	Bad[4] = 2;
	EXPECT(!GtfsStatic::ReadNetwork(Bad.data(), Bad.size(), Net), "version 2 accepted");
	Bad = Bytes;
	Bad[8] = 0xFF;
	Bad[9] = 0xFF;
	Bad[10] = 0xFF;
	Bad[11] = 0x7F;
	EXPECT(!GtfsStatic::ReadNetwork(Bad.data(), Bad.size(), Net), "huge route count accepted");

	// Random corruption: must never crash or read out of bounds (run under ASan), whatever it returns.
	std::mt19937 Random(1234);
	int Accepted = 0;
	for (int Run = 0; Run < 20000; ++Run)
	{
		std::vector<uint8_t> Mutated = Bytes;
		const int Flips = 1 + static_cast<int>(Random() % 4u);
		for (int F = 0; F < Flips; ++F)
		{
			Mutated[Random() % Mutated.size()] = static_cast<uint8_t>(Random() & 0xFFu);
		}
		GtfsStatic::FNetwork Fuzzed;
		if (GtfsStatic::ReadNetwork(Mutated.data(), Mutated.size(), Fuzzed))
		{
			++Accepted;
			for (const GtfsStatic::FShape& Shape : Fuzzed.Shapes)
			{
				EXPECT(Shape.RouteIndex < Fuzzed.Routes.size() && Shape.Points.size() >= 2, "accepted a bad shape");
			}
			for (const GtfsStatic::FStop& Stop : Fuzzed.Stops)
			{
				for (uint32_t Index : Stop.RouteIndices) EXPECT(Index < Fuzzed.Routes.size(), "accepted a bad stop route");
			}
		}
	}
	std::printf("  corruption fuzz: %d of 20000 mutated files still parsed (coordinates/colours/text changed)\n", Accepted);
}

static void TestAngles()
{
	EXPECT(Near(GtfsStatic::YawOf(1, 0), 0.0), "north");
	EXPECT(Near(GtfsStatic::YawOf(0, 1), 90.0), "east");
	EXPECT(Near(GtfsStatic::YawOf(-1, 0), 180.0), "south");
	EXPECT(Near(GtfsStatic::YawOf(0, -1), 270.0), "west");
	EXPECT(Near(GtfsStatic::YawDifference(350, 10), 20.0), "wrap difference");
	EXPECT(Near(GtfsStatic::YawDifference(-90, 270), 0.0), "negative difference");
	EXPECT(Near(GtfsStatic::ContinuousYaw(10, 20), 10.0), "keeps close direction");
	EXPECT(Near(GtfsStatic::ContinuousYaw(10, 200), 190.0), "flips to reference");
	EXPECT(Near(GtfsStatic::ContinuousYaw(350, 170), 170.0), "flip wraps");
	EXPECT(Near(GtfsStatic::ContinuousYaw(-30, 330), 330.0), "normalised");
}

// Two tram polylines on one centreline in opposite directions, a bus line, all in centimetres.
static void TestGeometry()
{
	GtfsStatic::FRouteGeometry Geometry;
	const std::vector<FVec2> North = { V(0, 0), V(10000, 0), V(10000, 0), V(20000, 0), V(20000, 10000) };
	const std::vector<FVec2> South = { V(20000, 10000), V(20000, 0), V(0, 0) };
	const int32_t A = Geometry.AddPolyline(0, 0, North);
	const int32_t B = Geometry.AddPolyline(0, 0, South);
	const int32_t Bus = Geometry.AddPolyline(1, 1, { V(0, 0), V(20000, 0) });          // same street, other layer
	const int32_t Single = Geometry.AddPolyline(2, 0, { V(0, 50000), V(10000, 50000) }); // lone track elsewhere
	EXPECT(Geometry.AddPolyline(3, 0, { V(5, 5), V(5, 5) }) == -1, "degenerate polyline accepted");
	EXPECT(A == 0 && B == 1 && Bus == 2 && Single == 3, "indices %d %d %d %d", A, B, Bus, Single);
	EXPECT(Geometry.PointsOf(A).size() == 4, "repeated point kept");
	EXPECT(Near(Geometry.LengthOf(A), 30000.0), "length %.1f", Geometry.LengthOf(A));

	Geometry.SeparateSharedCenterlines({ 175.0, 0.0 }, 100.0);
	Geometry.Build(5000.0);

	// Northbound moved east (its right), southbound moved west; the bus layer and the lone track did not move.
	EXPECT(Near(Geometry.PointsOf(A)[1].Y, 175.0), "northbound offset %.2f", Geometry.PointsOf(A)[1].Y);
	EXPECT(Near(Geometry.PointsOf(B)[2].Y, -175.0), "southbound end offset %.2f", Geometry.PointsOf(B)[2].Y);
	EXPECT(Near(Geometry.PointsOf(Bus)[1].Y, 0.0), "bus moved");
	EXPECT(Near(Geometry.PointsOf(Single)[0].Y, 50000.0), "lone track moved");
	// At the corner (20000, 0) both run in opposite directions too: the miter keeps the 175 cm from both legs.
	const FVec2 Corner = Geometry.PointsOf(A)[2];
	EXPECT(Near(Corner.X, 20000.0 - 175.0) && Near(Corner.Y, 175.0), "corner %.2f %.2f", Corner.X, Corner.Y);

	// Snapping: route filter, distance limit, direction preference.
	GtfsStatic::FSnap Snap;
	EXPECT(Geometry.Snap(0, V(5000, 30), 3000.0, false, 0.0, Snap), "no snap");
	EXPECT(Snap.Polyline == A && Near(Snap.Point.Y, 175.0) && Near(Snap.Distance, 5000.0, 1.0), "nearest: polyline %d at %.1f", Snap.Polyline, Snap.Point.Y);
	EXPECT(Geometry.Snap(0, V(5000, 30), 3000.0, true, 180.0, Snap) && Snap.Polyline == B, "southbound reference picked %d", Snap.Polyline);
	EXPECT(Near(Snap.Yaw, 180.0), "southbound yaw %.1f", Snap.Yaw);
	EXPECT(Geometry.Snap(1, V(5000, 30), 3000.0, true, 180.0, Snap) && Snap.Polyline == Bus, "bus snapped to %d", Snap.Polyline);
	EXPECT(!Geometry.Snap(0, V(5000, 9000), 3000.0, false, 0.0, Snap), "snapped from 90 m");
	EXPECT(!Geometry.Snap(7, V(5000, 0), 3000.0, false, 0.0, Snap), "snapped to a missing route");
	EXPECT(!Geometry.Snap(0, V(5000, 0), 1e12, false, 0.0, Snap), "absurd radius searched");
	// Only a wrong-way line in reach: still taken.
	EXPECT(Geometry.Snap(2, V(5000, 50100), 3000.0, true, 180.0, Snap) && Snap.Polyline == Single, "wrong-way only");

	// Point along a line, extrapolated past the ends.
	double Yaw = -1.0;
	FVec2 P = Geometry.PointAt(Bus, 5000.0, &Yaw);
	EXPECT(Near(P.X, 5000.0) && Near(P.Y, 0.0) && Near(Yaw, 0.0), "point at 5000");
	P = Geometry.PointAt(Bus, -1000.0, &Yaw);
	EXPECT(Near(P.X, -1000.0), "extrapolated before start %.1f", P.X);
	P = Geometry.PointAt(Bus, 25000.0);
	EXPECT(Near(P.X, 25000.0), "extrapolated past end %.1f", P.X);
	P = Geometry.PointAt(A, Geometry.LengthOf(A) - 100.0, &Yaw);
	EXPECT(Near(Yaw, 90.0) && Near(P.X, 20000.0 - 175.0), "last leg heading %.1f", Yaw);
	EXPECT(Geometry.Project(B, V(10000, 2000), Snap) && Near(Snap.Gap, 2175.0, 1e-3), "project gap %.2f", Snap.Gap);

	// A body riding round the corner sits on the chord.
	FVec2 Center;
	double BodyYaw = 0.0;
	const double CornerDistance = 10000.0 + 9825.0; // A now turns east at (19825, 175)
	GtfsStatic::ChordPose(Geometry, A, CornerDistance + 1000.0, CornerDistance - 1000.0, Center, BodyYaw);
	EXPECT(Near(BodyYaw, 45.0, 1e-6) && Near(Center.X, 19325.0) && Near(Center.Y, 675.0), "chord yaw %.2f at %.1f %.1f", BodyYaw, Center.X, Center.Y);
	GtfsStatic::ChordPose(Geometry, Bus, 3000.0, 1000.0, Center, BodyYaw);
	EXPECT(Near(Center.X, 2000.0) && Near(BodyYaw, 0.0), "straight chord %.1f %.1f", Center.X, BodyYaw);
}

static void TestFollower()
{
	GtfsStatic::FRouteGeometry Geometry;
	const int32_t Line = Geometry.AddPolyline(0, 0, { V(0, 0), V(100000, 0) });
	const int32_t Twin = Geometry.AddPolyline(0, 0, { V(0, 300), V(100000, 300) });   // close parallel shape of the route
	const int32_t Far = Geometry.AddPolyline(0, 0, { V(0, 9000), V(100000, 9000) });   // far away
	Geometry.Build(5000.0);
	GtfsStatic::FFollowLimits Limits;

	GtfsStatic::FSnap Snap;
	GtfsStatic::FTrackFollower Follower;
	EXPECT(Geometry.Project(Line, V(1000, 50), Snap), "project");
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 0.0, 10.0, Limits) == GtfsStatic::EFollow::Started, "start");
	EXPECT(Follower.Polyline == Line && Near(Follower.Distance, 1000.0) && Follower.Direction == 1, "started at %.1f", Follower.Distance);

	Geometry.Project(Line, V(11000, 0), Snap);
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 0.0, 10.0, Limits) == GtfsStatic::EFollow::Continued, "continue");
	EXPECT(Near(Follower.Speed, 1000.0), "speed %.1f", Follower.Speed);
	Follower.Advance(4.0);
	EXPECT(Near(Follower.Distance, 5000.0), "advanced to %.1f", Follower.Distance);
	Follower.Advance(60.0);
	EXPECT(Near(Follower.Distance, 11000.0) && Follower.Speed == 0.0, "stops at the report: %.1f", Follower.Distance);

	Geometry.Project(Line, V(10000, 0), Snap); // 10 m behind: GPS noise
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 0.0, 10.0, Limits) == GtfsStatic::EFollow::HeldBack, "hold back");
	EXPECT(Near(Follower.Distance, 11000.0) && Follower.Speed == 0.0, "held at %.1f", Follower.Distance);

	Geometry.Project(Twin, V(15000, 300), Snap); // the other shape of the route, 3 m aside
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 0.0, 10.0, Limits) == GtfsStatic::EFollow::Switched, "switch");
	EXPECT(Follower.Polyline == Twin && Near(Follower.Distance, 11000.0) && Near(Follower.Speed, 400.0), "switched at %.1f speed %.1f", Follower.Distance, Follower.Speed);

	Geometry.Project(Far, V(20000, 9000), Snap); // 90 m aside: no plausible way there
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 0.0, 10.0, Limits) == GtfsStatic::EFollow::Jumped, "jump sideways");
	EXPECT(Follower.Polyline == Far && Near(Follower.Distance, 20000.0), "jumped to %.1f", Follower.Distance);

	Geometry.Project(Far, V(5000, 9000), Snap); // 150 m behind: believed
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 0.0, 10.0, Limits) == GtfsStatic::EFollow::Jumped, "jump back");
	EXPECT(Near(Follower.Distance, 5000.0), "jumped back to %.1f", Follower.Distance);

	// Travelling against the point order: distances shrink as it moves on.
	Geometry.Project(Far, V(4000, 9000), Snap);
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 180.0, 10.0, Limits) == GtfsStatic::EFollow::Jumped, "reversed");
	EXPECT(Follower.Direction == -1, "direction %d", Follower.Direction);
	Geometry.Project(Far, V(2000, 9000), Snap);
	EXPECT(GtfsStatic::UpdateFollower(Geometry, Follower, Snap, 180.0, 4.0, Limits) == GtfsStatic::EFollow::Continued, "continue backwards");
	Follower.Advance(2.0);
	EXPECT(Near(Follower.Distance, 3000.0), "moving backwards %.1f", Follower.Distance);
	Follower.Advance(100.0);
	EXPECT(Near(Follower.Distance, 2000.0), "reached %.1f", Follower.Distance);

	Follower.Stop();
	EXPECT(!Follower.IsActive(), "stopped");
}

static void TestStrips()
{
	using GtfsStatic::FStripProfile;
	// An L-shaped line: 10 m north, then 10 m east.
	const std::vector<FVec2> Points = { V(0, 0), V(1000, 0), V(1000, 1000) };
	const std::vector<FVec2> Miters = GtfsStatic::RightMiters(Points);
	EXPECT(Near(Miters[0].X, 0.0) && Near(Miters[0].Y, 1.0), "start miter points east");
	EXPECT(Near(Miters[1].X, -1.0) && Near(Miters[1].Y, 1.0), "corner miter %.3f %.3f", Miters[1].X, Miters[1].Y);

	FStripProfile Profile;
	Profile.Left = -50.0;
	Profile.Right = 50.0;
	Profile.TopZ = 5.0;
	Profile.BottomZ = 0.0;
	Profile.bSides = true;
	CityMesh::FBuffer Buffer;
	for (size_t S = 0; S + 1 < Points.size(); ++S)
	{
		GtfsStatic::AppendStripSegment(Points, Miters, S, Profile, 100.0, 200.0, Buffer);
	}
	EXPECT(Buffer.VertexCount() == 24 && Buffer.Indices.size() == 36, "%zu vertices %zu indices", Buffer.VertexCount(), Buffer.Indices.size());

	double TopArea = 0.0;
	for (size_t T = 0; T < Buffer.Indices.size() / 3; ++T)
	{
		double Corner[3][3];
		for (int K = 0; K < 3; ++K)
		{
			const size_t Vertex = Buffer.Indices[T * 3 + static_cast<size_t>(K)];
			for (int D = 0; D < 3; ++D) Corner[K][D] = static_cast<double>(Buffer.Positions[Vertex * 3 + static_cast<size_t>(D)]);
		}
		const double U[3] = { Corner[1][0] - Corner[0][0], Corner[1][1] - Corner[0][1], Corner[1][2] - Corner[0][2] };
		const double W[3] = { Corner[2][0] - Corner[0][0], Corner[2][1] - Corner[0][1], Corner[2][2] - Corner[0][2] };
		const double Cross[3] = { U[1] * W[2] - U[2] * W[1], U[2] * W[0] - U[0] * W[2], U[0] * W[1] - U[1] * W[0] };
		const size_t V0 = Buffer.Indices[T * 3];
		const double Normal[3] = { static_cast<double>(Buffer.Normals[V0 * 3]), static_cast<double>(Buffer.Normals[V0 * 3 + 1]), static_cast<double>(Buffer.Normals[V0 * 3 + 2]) };
		const double Length = std::sqrt(Cross[0] * Cross[0] + Cross[1] * Cross[1] + Cross[2] * Cross[2]);
		EXPECT(Length > 0.0 && (Cross[0] * Normal[0] + Cross[1] * Normal[1] + Cross[2] * Normal[2]) / Length > 0.999,
			"triangle %zu winding disagrees with its normal", T);
		if (Normal[2] > 0.5) TopArea += 0.5 * Length;
		if (Normal[2] < 0.5)
		{
			// A side wall: its normal points away from the line's centre.
			const double CX = (Corner[0][0] + Corner[1][0] + Corner[2][0]) / 3.0 + 100.0;
			const double CY = (Corner[0][1] + Corner[1][1] + Corner[2][1]) / 3.0 + 200.0;
			const double ToCenterX = (T < 6 ? 500.0 : 1000.0) - CX;
			const double ToCenterY = (T < 6 ? 0.0 : 500.0) - CY;
			EXPECT(ToCenterX * Normal[0] + ToCenterY * Normal[1] < 0.0, "side triangle %zu faces inwards", T);
		}
	}
	// Two 10 m x 1 m strips joined with a miter: exactly 2 x 10 m2 (the corner square is shared half/half).
	EXPECT(Near(TopArea, 2.0 * 1000.0 * 100.0, 1.0), "top area %.1f", TopArea);

	GtfsStatic::FSegmentSet Seen(20.0);
	EXPECT(Seen.Insert(V(0, 0), V(1000, 0)), "first insert");
	EXPECT(!Seen.Insert(V(1000, 3), V(4, 0)), "reverse duplicate not caught");
	EXPECT(Seen.Insert(V(0, 0), V(1000, 400)), "different segment refused");
}

static void TestText()
{
	EXPECT(GtfsStatic::FoldDoubleAcute("Ny\xC5\x91g\xC3\xA9r \xC5\x90 \xC5\xB1 \xC5\xB0 \xC5\x81") == "Ny\xC3\xB6g\xC3\xA9r \xC3\x96 \xC3\xBC \xC3\x9C \xC5\x81", "fold");
	EXPECT(GtfsStatic::FoldDoubleAcute("\xC5") == "\xC5", "truncated lead byte");
	// "(Népszínház" is 11 characters but 14 bytes: wrapping counts characters.
	const std::vector<std::string> Lines = GtfsStatic::WrapWords("Blaha  Lujza t\xC3\xA9r M (N\xC3\xA9psz\xC3\xADnh\xC3\xA1z utca)", 12);
	const std::vector<std::string> Expected = { "Blaha Lujza", "t\xC3\xA9r M", "(N\xC3\xA9psz\xC3\xADnh\xC3\xA1z", "utca)" };
	EXPECT(Lines == Expected, "%zu lines, first '%s'", Lines.size(), Lines.empty() ? "" : Lines[0].c_str());
	EXPECT((GtfsStatic::WrapWords("Kerepesi \xC3\xBAt", 12) == std::vector<std::string>{ "Kerepesi \xC3\xBAt" }), "12 characters fit");
	EXPECT(GtfsStatic::WrapWords("   ", 10).empty(), "blank text");
	EXPECT(GtfsStatic::WrapWords("Szigony utca", 40).size() == 1, "short text wrapped");
}

int main(int Argc, char** Argv)
{
	const std::string Fixtures = Argc > 1 ? Argv[1] : "Transit/fixtures";
	TestRouteTypes();
	TestFixture(Load(Fixtures + "/sample_transit.bsb"));
	TestAngles();
	TestGeometry();
	TestFollower();
	TestStrips();
	TestText();
	if (Failures != 0)
	{
		std::printf("%d transit check(s) FAILED\n", Failures);
		return 1;
	}
	std::printf("transit static data: all checks passed\n");
	return 0;
}
