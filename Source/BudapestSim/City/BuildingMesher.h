// Extrudes a building footprint (with optional courtyards) into walls and a flat roof.
// Plain C++ so the winding/closure maths can be tested outside the engine.
//
// Coordinates are the project's world frame: X = north, Y = east, Z = up (see GeoProjection.h),
// in any consistent unit. Triangle winding follows Unreal's convention (clockwise seen from the
// front face), which in this frame means the right-handed cross product (B-A)x(C-A) points OUT of
// the solid for every triangle.
#pragma once

#include <cstdint>
#include <vector>

namespace CityMesh
{
	struct FPoint2
	{
		double X = 0.0;
		double Y = 0.0;
	};

	struct FBuffer
	{
		std::vector<float> Positions; // x,y,z triplets
		std::vector<float> Normals;   // x,y,z triplets, one per vertex
		std::vector<uint32_t> Indices;

		size_t VertexCount() const { return Positions.size() / 3; }
	};

	// Signed area in the XY plane (positive when the ring runs from +X toward +Y, i.e. counter-clockwise in math terms).
	double SignedArea(const std::vector<FPoint2>& Ring);

	// Appends walls for every ring (Rings[0] = outer boundary, the rest = holes) to OutWalls and the
	// roof, built from the pre-triangulated RoofIndices (indices into all ring points concatenated),
	// to OutRoof. Offsets subtract an origin so large coordinates stay precise as floats.
	// Returns false (appending nothing) if the input is unusable.
	bool AppendBuilding(const std::vector<std::vector<FPoint2>>& Rings,
		const std::vector<uint32_t>& RoofIndices,
		double BaseZ,
		double TopZ,
		double OriginX,
		double OriginY,
		FBuffer& OutWalls,
		FBuffer& OutRoof);
}
