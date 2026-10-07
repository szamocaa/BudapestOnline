// Tests City/BsbReader (against files written by the Python baker) and City/BuildingMesher.
#include "City/BsbReader.h"
#include "City/BuildingMesher.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
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

static std::vector<uint8_t> Load(const std::string& Path)
{
	std::ifstream In(Path, std::ios::binary);
	return std::vector<uint8_t>((std::istreambuf_iterator<char>(In)), std::istreambuf_iterator<char>());
}

// Same flat projection as GeoProjection.h, in metres.
static CityMesh::FPoint2 Project(const Bsb::FPoint& P, double OriginLat, double OriginLon)
{
	const double Pi = 3.14159265358979323846;
	const double R = 6371008.8;
	CityMesh::FPoint2 Out;
	Out.X = (P.Latitude - OriginLat) * Pi / 180.0 * R;
	Out.Y = (P.Longitude - OriginLon) * Pi / 180.0 * R * std::cos(OriginLat * Pi / 180.0);
	return Out;
}

static bool InPolygon(double X, double Y, const std::vector<CityMesh::FPoint2>& Poly)
{
	bool Inside = false;
	for (size_t I = 0, N = Poly.size(); I < N; ++I)
	{
		const CityMesh::FPoint2& A = Poly[I];
		const CityMesh::FPoint2& B = Poly[(I + 1) % N];
		if ((A.X > X) != (B.X > X) && Y < (B.Y - A.Y) * (X - A.X) / (B.X - A.X) + A.Y)
		{
			Inside = !Inside;
		}
	}
	return Inside;
}

static bool InSolid(double X, double Y, const std::vector<std::vector<CityMesh::FPoint2>>& Rings)
{
	if (!InPolygon(X, Y, Rings[0])) return false;
	for (size_t R = 1; R < Rings.size(); ++R)
	{
		if (InPolygon(X, Y, Rings[R])) return false;
	}
	return true;
}

struct FTri
{
	double A[3], B[3], C[3];
	double Cross[3];
	double Area;
};

static FTri GetTri(const CityMesh::FBuffer& Buf, size_t Tri)
{
	FTri T;
	const uint32_t I[3] = { Buf.Indices[Tri * 3], Buf.Indices[Tri * 3 + 1], Buf.Indices[Tri * 3 + 2] };
	double* Dst[3] = { T.A, T.B, T.C };
	for (int V = 0; V < 3; ++V)
		for (int K = 0; K < 3; ++K)
			Dst[V][K] = static_cast<double>(Buf.Positions[I[V] * 3 + static_cast<size_t>(K)]);
	const double U[3] = { T.B[0] - T.A[0], T.B[1] - T.A[1], T.B[2] - T.A[2] };
	const double W[3] = { T.C[0] - T.A[0], T.C[1] - T.A[1], T.C[2] - T.A[2] };
	T.Cross[0] = U[1] * W[2] - U[2] * W[1];
	T.Cross[1] = U[2] * W[0] - U[0] * W[2];
	T.Cross[2] = U[0] * W[1] - U[1] * W[0];
	T.Area = 0.5 * std::sqrt(T.Cross[0] * T.Cross[0] + T.Cross[1] * T.Cross[1] + T.Cross[2] * T.Cross[2]);
	return T;
}

// Verifies winding, normals, closure and areas for one meshed building; returns total wall+roof volume.
static void CheckBuilding(const char* Name, const std::vector<std::vector<CityMesh::FPoint2>>& Rings,
	const std::vector<uint32_t>& Roof, double Height)
{
	CityMesh::FBuffer Walls, RoofBuf;
	EXPECT(CityMesh::AppendBuilding(Rings, Roof, 0.0, Height, 0.0, 0.0, Walls, RoofBuf), "%s: AppendBuilding failed", Name);

	double Perimeter = 0.0, FootArea = std::fabs(CityMesh::SignedArea(Rings[0]));
	for (size_t R = 0; R < Rings.size(); ++R)
	{
		const std::vector<CityMesh::FPoint2>& Ring = Rings[R];
		for (size_t I = 0; I < Ring.size(); ++I)
		{
			const CityMesh::FPoint2& A = Ring[I];
			const CityMesh::FPoint2& B = Ring[(I + 1) % Ring.size()];
			Perimeter += std::hypot(B.X - A.X, B.Y - A.Y);
		}
		if (R > 0) FootArea -= std::fabs(CityMesh::SignedArea(Ring));
	}

	double Volume = 0.0, WallArea = 0.0, RoofArea = 0.0;
	for (size_t T = 0; T < Walls.Indices.size() / 3; ++T)
	{
		const FTri Tri = GetTri(Walls, T);
		Volume += (Tri.A[0] * (Tri.B[1] * Tri.C[2] - Tri.B[2] * Tri.C[1]) - Tri.A[1] * (Tri.B[0] * Tri.C[2] - Tri.B[2] * Tri.C[0]) +
			Tri.A[2] * (Tri.B[0] * Tri.C[1] - Tri.B[1] * Tri.C[0])) / 6.0;
		WallArea += Tri.Area;

		// Face normal (from winding) must equal the stored vertex normal and point out of the solid.
		const uint32_t V0 = Walls.Indices[T * 3];
		const double NX = static_cast<double>(Walls.Normals[V0 * 3]), NY = static_cast<double>(Walls.Normals[V0 * 3 + 1]);
		const double Len = std::sqrt(Tri.Cross[0] * Tri.Cross[0] + Tri.Cross[1] * Tri.Cross[1] + Tri.Cross[2] * Tri.Cross[2]);
		EXPECT(Len > 0 && (Tri.Cross[0] * NX + Tri.Cross[1] * NY) / Len > 0.999, "%s: wall tri %zu winding disagrees with its normal", Name, T);
		const double CX = (Tri.A[0] + Tri.B[0] + Tri.C[0]) / 3.0, CY = (Tri.A[1] + Tri.B[1] + Tri.C[1]) / 3.0;
		EXPECT(!InSolid(CX + 0.01 * NX, CY + 0.01 * NY, Rings), "%s: wall tri %zu normal points into the solid", Name, T);
		EXPECT(InSolid(CX - 0.01 * NX, CY - 0.01 * NY, Rings), "%s: wall tri %zu is not on the boundary", Name, T);
	}
	for (size_t T = 0; T < RoofBuf.Indices.size() / 3; ++T)
	{
		const FTri Tri = GetTri(RoofBuf, T);
		Volume += (Tri.A[0] * (Tri.B[1] * Tri.C[2] - Tri.B[2] * Tri.C[1]) - Tri.A[1] * (Tri.B[0] * Tri.C[2] - Tri.B[2] * Tri.C[0]) +
			Tri.A[2] * (Tri.B[0] * Tri.C[1] - Tri.B[1] * Tri.C[0])) / 6.0;
		RoofArea += Tri.Area;
		EXPECT(Tri.Cross[2] > 0.0, "%s: roof tri %zu faces down", Name, T);
	}

	EXPECT(std::fabs(WallArea - Perimeter * Height) < 1e-3 * Perimeter * Height, "%s: wall area %.2f != perimeter*height %.2f", Name, WallArea, Perimeter * Height);
	EXPECT(std::fabs(RoofArea - FootArea) < 1e-3 * FootArea, "%s: roof area %.2f != footprint %.2f", Name, RoofArea, FootArea);
	// Divergence theorem: with the floor at z=0 contributing nothing, outward-wound walls+roof give area*height.
	EXPECT(std::fabs(Volume - FootArea * Height) < 2e-3 * FootArea * Height, "%s: volume %.2f != area*height %.2f (wrong winding or open mesh)", Name, Volume, FootArea * Height);
}

// Reverses ring I's vertex order and remaps the roof indices to match.
static void ReverseRing(std::vector<std::vector<CityMesh::FPoint2>>& Rings, std::vector<uint32_t>& Roof, size_t RingIndex)
{
	size_t Offset = 0;
	for (size_t R = 0; R < RingIndex; ++R) Offset += Rings[R].size();
	const size_t N = Rings[RingIndex].size();
	std::vector<CityMesh::FPoint2> Reversed(Rings[RingIndex].rbegin(), Rings[RingIndex].rend());
	Rings[RingIndex] = Reversed;
	for (uint32_t& Index : Roof)
	{
		if (Index >= Offset && Index < Offset + N) Index = static_cast<uint32_t>(Offset + (N - 1 - (Index - Offset)));
	}
}

int main(int argc, char** argv)
{
	const std::string Dir = argc > 1 ? argv[1] : "../Districts/fixtures";

	// --- Buildings file ---
	const std::vector<uint8_t> BuildingBytes = Load(Dir + "/sample_buildings.bsb");
	Bsb::FBuildings Buildings;
	EXPECT(!BuildingBytes.empty() && Bsb::ReadBuildings(BuildingBytes.data(), BuildingBytes.size(), Buildings), "cannot read buildings fixture");
	EXPECT(Buildings.Items.size() == 4, "expected 4 buildings, got %zu", Buildings.Items.size());
	if (Buildings.Items.size() == 4)
	{
		EXPECT(Buildings.Items[0].OsmId == 1001 && Buildings.Items[0].HeightMeters == 16.0f, "building 1001 header");
		EXPECT(Buildings.Items[0].Rings.size() == 1 && Buildings.Items[0].Rings[0].size() == 4, "building 1001 ring");
		EXPECT(Buildings.Items[2].OsmId == 2001 && Buildings.Items[2].Rings.size() == 2, "multipolygon with courtyard");
		EXPECT(std::fabs(static_cast<double>(Buildings.Items[1].HeightMeters) - 12.5) < 1e-6, "explicit height");
	}

	// --- Paths file ---
	const std::vector<uint8_t> PathBytes = Load(Dir + "/sample_paths.bsb");
	Bsb::FPaths Paths;
	EXPECT(!PathBytes.empty() && Bsb::ReadPaths(PathBytes.data(), PathBytes.size(), Paths), "cannot read paths fixture");
	EXPECT(Paths.Nodes.size() == 7 && Paths.Edges.size() == 6, "paths: %zu nodes, %zu edges", Paths.Nodes.size(), Paths.Edges.size());
	int Classes[3] = { 0, 0, 0 };
	for (const Bsb::FPathEdge& E : Paths.Edges) { if (E.Class < 3) ++Classes[E.Class]; }
	EXPECT(Classes[0] == 1 && Classes[1] == 4 && Classes[2] == 1, "edge class histogram %d/%d/%d", Classes[0], Classes[1], Classes[2]);

	// --- Reader robustness: truncations and corruption must be rejected or survive, never crash ---
	size_t Rejected = 0;
	for (size_t Len = 0; Len < BuildingBytes.size(); ++Len)
	{
		Bsb::FBuildings Partial;
		if (!Bsb::ReadBuildings(BuildingBytes.data(), Len, Partial)) ++Rejected;
	}
	EXPECT(Rejected == BuildingBytes.size(), "every strict prefix must fail to parse (%zu/%zu rejected)", Rejected, BuildingBytes.size());
	for (size_t Len = 0; Len < PathBytes.size(); ++Len)
	{
		Bsb::FPaths Partial;
		EXPECT(!Bsb::ReadPaths(PathBytes.data(), Len, Partial), "paths prefix %zu must fail", Len);
	}
	std::srand(99);
	for (int Iter = 0; Iter < 20000; ++Iter)
	{
		std::vector<uint8_t> Mutated = BuildingBytes;
		for (int F = 0; F < 3; ++F) Mutated[static_cast<size_t>(std::rand()) % Mutated.size()] = static_cast<uint8_t>(std::rand());
		Bsb::FBuildings Garbage;
		Bsb::ReadBuildings(Mutated.data(), Mutated.size(), Garbage);
		std::vector<uint8_t> MutatedPaths = PathBytes;
		MutatedPaths[static_cast<size_t>(std::rand()) % MutatedPaths.size()] = static_cast<uint8_t>(std::rand());
		Bsb::FPaths GarbagePaths;
		Bsb::ReadPaths(MutatedPaths.data(), MutatedPaths.size(), GarbagePaths);
	}
	// A giant claimed count must not allocate gigabytes.
	{
		std::vector<uint8_t> Evil = { 'B', 'S', 'B', 'B', 1, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF };
		Bsb::FBuildings Out;
		EXPECT(!Bsb::ReadBuildings(Evil.data(), Evil.size(), Out), "absurd building count accepted");
	}

	// --- Mesher: every baked building, in all four ring-orientation combinations ---
	const double OriginLat = 47.4930, OriginLon = 19.0800;
	for (const Bsb::FBuilding& B : Buildings.Items)
	{
		std::vector<std::vector<CityMesh::FPoint2>> Rings;
		for (const std::vector<Bsb::FPoint>& Ring : B.Rings)
		{
			std::vector<CityMesh::FPoint2> Projected;
			for (const Bsb::FPoint& P : Ring) Projected.push_back(Project(P, OriginLat, OriginLon));
			Rings.push_back(Projected);
		}
		for (int Combo = 0; Combo < 4; ++Combo)
		{
			std::vector<std::vector<CityMesh::FPoint2>> Variant = Rings;
			std::vector<uint32_t> Roof = B.RoofIndices;
			if (Combo & 1) ReverseRing(Variant, Roof, 0);
			if ((Combo & 2) && Variant.size() > 1) ReverseRing(Variant, Roof, 1);
			char Name[64];
			std::snprintf(Name, sizeof(Name), "osm %llu combo %d", static_cast<unsigned long long>(B.OsmId), Combo);
			CheckBuilding(Name, Variant, Roof, static_cast<double>(B.HeightMeters));
		}
	}

	// Rejects bad input without touching the buffers.
	{
		CityMesh::FBuffer W, R;
		std::vector<std::vector<CityMesh::FPoint2>> Bad = { { {0, 0}, {1, 0} } };
		EXPECT(!CityMesh::AppendBuilding(Bad, {}, 0.0, 10.0, 0, 0, W, R) && W.Indices.empty(), "degenerate ring accepted");
		std::vector<std::vector<CityMesh::FPoint2>> Tri = { { {0, 0}, {10, 0}, {0, 10} } };
		EXPECT(!CityMesh::AppendBuilding(Tri, { 0, 1, 7 }, 0.0, 10.0, 0, 0, W, R), "roof index out of range accepted");
		EXPECT(!CityMesh::AppendBuilding(Tri, { 0, 1, 2 }, 5.0, 5.0, 0, 0, W, R), "zero height accepted");
	}

	if (Failures == 0)
	{
		std::printf("OK city: baked files read correctly, %zu prefix cuts rejected, meshes closed with outward normals in all ring orientations\n", Rejected);
		return 0;
	}
	std::printf("FAILED: %d\n", Failures);
	return 1;
}
