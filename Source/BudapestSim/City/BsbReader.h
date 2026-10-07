// Reader for the baked district data files written by Tools/Districts/bake_district.py.
// Plain C++ (no Unreal types) so it can be tested outside the engine.
//
// All integers/floats are little-endian.
//
//   Buildings file ("BSBB", version 1)
//     u32 buildingCount
//     per building:
//       u64 osmId, f32 heightMeters, f32 minHeightMeters,
//       u32 ringCount                       (ring 0 = outer boundary, the rest = courtyards/holes)
//       per ring: u32 pointCount, pointCount x (f64 lat, f64 lon)   (closing point NOT repeated)
//       u32 indexCount, indexCount x u32    (roof triangles, indices into all ring points in order)
//
//   Paths file ("BSBP", version 1)
//     u32 nodeCount, nodeCount x (f64 lat, f64 lon)
//     u32 edgeCount, edgeCount x (u32 nodeA, u32 nodeB, u8 class, u8 pad[3])
//     class: 0 = footpath/pedestrian, 1 = quiet street, 2 = main road
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace Bsb
{
	struct FPoint
	{
		double Latitude = 0.0;
		double Longitude = 0.0;
	};

	struct FBuilding
	{
		uint64_t OsmId = 0;
		float HeightMeters = 0.0f;
		float MinHeightMeters = 0.0f;
		std::vector<std::vector<FPoint>> Rings;
		std::vector<uint32_t> RoofIndices;
	};

	struct FBuildings
	{
		std::vector<FBuilding> Items;
	};

	struct FPathEdge
	{
		uint32_t NodeA = 0;
		uint32_t NodeB = 0;
		uint8_t Class = 0;
	};

	struct FPaths
	{
		std::vector<FPoint> Nodes;
		std::vector<FPathEdge> Edges;
	};

	// Both return false (leaving Out in an unspecified state) on a bad magic/version, truncation,
	// or indices that point outside the data they refer to.
	bool ReadBuildings(const uint8_t* Data, size_t Size, FBuildings& Out);
	bool ReadPaths(const uint8_t* Data, size_t Size, FPaths& Out);
}
