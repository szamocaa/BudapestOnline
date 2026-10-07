#include "City/BsbReader.h"

#include <cstring>

namespace Bsb
{
namespace
{
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

		bool ReadU32(uint32_t& Out)
		{
			if (Remaining() < 4) return false;
			Out = static_cast<uint32_t>(Cur[0]) | (static_cast<uint32_t>(Cur[1]) << 8) |
				(static_cast<uint32_t>(Cur[2]) << 16) | (static_cast<uint32_t>(Cur[3]) << 24);
			Cur += 4;
			return true;
		}

		bool ReadU64(uint64_t& Out)
		{
			uint32_t Low = 0;
			uint32_t High = 0;
			if (!ReadU32(Low) || !ReadU32(High)) return false;
			Out = static_cast<uint64_t>(Low) | (static_cast<uint64_t>(High) << 32);
			return true;
		}

		bool ReadF32(float& Out)
		{
			uint32_t Bits = 0;
			if (!ReadU32(Bits)) return false;
			std::memcpy(&Out, &Bits, sizeof(Out));
			return true;
		}

		bool ReadF64(double& Out)
		{
			uint64_t Bits = 0;
			if (!ReadU64(Bits)) return false;
			std::memcpy(&Out, &Bits, sizeof(Out));
			return true;
		}

		bool ReadMagic(const char (&Magic)[5])
		{
			if (Remaining() < 4 || std::memcmp(Cur, Magic, 4) != 0) return false;
			Cur += 4;
			return true;
		}

		bool ReadPoint(FPoint& Out) { return ReadF64(Out.Latitude) && ReadF64(Out.Longitude); }

	private:
		const uint8_t* Cur;
		const uint8_t* End;
	};

	constexpr uint32_t SupportedVersion = 1;
	constexpr size_t PointBytes = 16;
	constexpr size_t IndexBytes = 4;
	constexpr size_t EdgeBytes = 12;
}

bool ReadBuildings(const uint8_t* Data, size_t Size, FBuildings& Out)
{
	Out = FBuildings();
	FCursor Cursor(Data, Size);

	uint32_t Version = 0;
	uint32_t Count = 0;
	if (!Cursor.ReadMagic("BSBB") || !Cursor.ReadU32(Version) || Version != SupportedVersion || !Cursor.ReadU32(Count))
	{
		return false;
	}
	// Every building takes at least 24 bytes; refuse counts the file could not possibly hold.
	if (static_cast<size_t>(Count) > Cursor.Remaining() / 24)
	{
		return false;
	}

	Out.Items.resize(Count);
	for (FBuilding& Building : Out.Items)
	{
		uint32_t RingCount = 0;
		if (!Cursor.ReadU64(Building.OsmId) || !Cursor.ReadF32(Building.HeightMeters) ||
			!Cursor.ReadF32(Building.MinHeightMeters) || !Cursor.ReadU32(RingCount))
		{
			return false;
		}
		if (RingCount == 0 || static_cast<size_t>(RingCount) > Cursor.Remaining() / 4)
		{
			return false;
		}

		Building.Rings.resize(RingCount);
		size_t TotalPoints = 0;
		for (std::vector<FPoint>& Ring : Building.Rings)
		{
			uint32_t PointCount = 0;
			if (!Cursor.ReadU32(PointCount) || static_cast<size_t>(PointCount) > Cursor.Remaining() / PointBytes)
			{
				return false;
			}
			Ring.resize(PointCount);
			for (FPoint& Point : Ring)
			{
				if (!Cursor.ReadPoint(Point)) return false;
			}
			TotalPoints += PointCount;
		}

		uint32_t IndexCount = 0;
		if (!Cursor.ReadU32(IndexCount) || IndexCount % 3 != 0 || static_cast<size_t>(IndexCount) > Cursor.Remaining() / IndexBytes)
		{
			return false;
		}
		Building.RoofIndices.resize(IndexCount);
		for (uint32_t& Index : Building.RoofIndices)
		{
			if (!Cursor.ReadU32(Index) || Index >= TotalPoints) return false;
		}
	}
	return true;
}

bool ReadPaths(const uint8_t* Data, size_t Size, FPaths& Out)
{
	Out = FPaths();
	FCursor Cursor(Data, Size);

	uint32_t Version = 0;
	uint32_t NodeCount = 0;
	if (!Cursor.ReadMagic("BSBP") || !Cursor.ReadU32(Version) || Version != SupportedVersion || !Cursor.ReadU32(NodeCount) ||
		static_cast<size_t>(NodeCount) > Cursor.Remaining() / PointBytes)
	{
		return false;
	}

	Out.Nodes.resize(NodeCount);
	for (FPoint& Node : Out.Nodes)
	{
		if (!Cursor.ReadPoint(Node)) return false;
	}

	uint32_t EdgeCount = 0;
	if (!Cursor.ReadU32(EdgeCount) || static_cast<size_t>(EdgeCount) > Cursor.Remaining() / EdgeBytes)
	{
		return false;
	}

	Out.Edges.resize(EdgeCount);
	for (FPathEdge& Edge : Out.Edges)
	{
		uint8_t Padding = 0;
		if (!Cursor.ReadU32(Edge.NodeA) || !Cursor.ReadU32(Edge.NodeB) || !Cursor.ReadU8(Edge.Class) ||
			!Cursor.ReadU8(Padding) || !Cursor.ReadU8(Padding) || !Cursor.ReadU8(Padding))
		{
			return false;
		}
		if (Edge.NodeA >= NodeCount || Edge.NodeB >= NodeCount) return false;
	}
	return true;
}
}
