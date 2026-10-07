#include "GtfsRtDecoder.h"

#include <cstring>
#include <utility>

namespace GtfsRt
{
namespace
{
	constexpr uint32_t WireVarint = 0;
	constexpr uint32_t WireFixed64 = 1;
	constexpr uint32_t WireLengthDelimited = 2;
	constexpr uint32_t WireFixed32 = 5;

	class FReader
	{
	public:
		FReader() = default;
		FReader(const uint8_t* InData, size_t InSize) : Cur(InData), End(InData + InSize) {}

		bool AtEnd() const { return Cur >= End; }

		bool ReadVarint(uint64_t& Out)
		{
			Out = 0;
			for (uint32_t Shift = 0; Shift < 70; Shift += 7)
			{
				if (Cur >= End)
				{
					return false;
				}
				const uint8_t Byte = *Cur++;
				if (Shift < 64)
				{
					Out |= static_cast<uint64_t>(Byte & 0x7F) << Shift;
				}
				if ((Byte & 0x80) == 0)
				{
					return true;
				}
			}
			return false;
		}

		bool ReadTag(uint32_t& OutField, uint32_t& OutWire)
		{
			uint64_t Key = 0;
			if (!ReadVarint(Key))
			{
				return false;
			}
			OutField = static_cast<uint32_t>(Key >> 3);
			OutWire = static_cast<uint32_t>(Key & 7);
			return OutField != 0;
		}

		bool ReadSubMessage(FReader& OutSub)
		{
			uint64_t Length = 0;
			if (!ReadVarint(Length) || Length > static_cast<uint64_t>(End - Cur))
			{
				return false;
			}
			OutSub = FReader(Cur, static_cast<size_t>(Length));
			Cur += Length;
			return true;
		}

		bool ReadString(std::string& OutString)
		{
			FReader Sub;
			if (!ReadSubMessage(Sub))
			{
				return false;
			}
			OutString.assign(reinterpret_cast<const char*>(Sub.Cur), static_cast<size_t>(Sub.End - Sub.Cur));
			return true;
		}

		bool ReadFixed32(uint32_t& OutValue)
		{
			if (End - Cur < 4)
			{
				return false;
			}
			OutValue = static_cast<uint32_t>(Cur[0]) | (static_cast<uint32_t>(Cur[1]) << 8) |
				(static_cast<uint32_t>(Cur[2]) << 16) | (static_cast<uint32_t>(Cur[3]) << 24);
			Cur += 4;
			return true;
		}

		bool ReadFloat(float& OutValue)
		{
			uint32_t Bits = 0;
			if (!ReadFixed32(Bits))
			{
				return false;
			}
			std::memcpy(&OutValue, &Bits, sizeof(OutValue));
			return true;
		}

		bool Skip(uint32_t Wire)
		{
			switch (Wire)
			{
			case WireVarint:
			{
				uint64_t Ignored = 0;
				return ReadVarint(Ignored);
			}
			case WireFixed64:
				if (End - Cur < 8)
				{
					return false;
				}
				Cur += 8;
				return true;
			case WireLengthDelimited:
			{
				FReader Ignored;
				return ReadSubMessage(Ignored);
			}
			case WireFixed32:
				if (End - Cur < 4)
				{
					return false;
				}
				Cur += 4;
				return true;
			default:
				// Groups are long deprecated and never used by GTFS-realtime.
				return false;
			}
		}

	private:
		const uint8_t* Cur = nullptr;
		const uint8_t* End = nullptr;
	};

	// message TripDescriptor { trip_id = 1; start_time = 2; start_date = 3; route_id = 5; direction_id = 6; }
	bool ParseTrip(FReader Reader, FVehicleRecord& Vehicle)
	{
		while (!Reader.AtEnd())
		{
			uint32_t Field = 0;
			uint32_t Wire = 0;
			if (!Reader.ReadTag(Field, Wire))
			{
				return false;
			}

			if (Field == 1 && Wire == WireLengthDelimited)
			{
				if (!Reader.ReadString(Vehicle.TripId)) return false;
			}
			else if (Field == 5 && Wire == WireLengthDelimited)
			{
				if (!Reader.ReadString(Vehicle.RouteId)) return false;
			}
			else if (Field == 6 && Wire == WireVarint)
			{
				uint64_t Value = 0;
				if (!Reader.ReadVarint(Value)) return false;
				Vehicle.DirectionId = static_cast<int32_t>(Value);
			}
			else if (!Reader.Skip(Wire))
			{
				return false;
			}
		}
		return true;
	}

	// message VehicleDescriptor { id = 1; label = 2; license_plate = 3; }
	bool ParseVehicleDescriptor(FReader Reader, FVehicleRecord& Vehicle)
	{
		while (!Reader.AtEnd())
		{
			uint32_t Field = 0;
			uint32_t Wire = 0;
			if (!Reader.ReadTag(Field, Wire))
			{
				return false;
			}

			if (Field == 1 && Wire == WireLengthDelimited)
			{
				if (!Reader.ReadString(Vehicle.VehicleId)) return false;
			}
			else if (Field == 2 && Wire == WireLengthDelimited)
			{
				if (!Reader.ReadString(Vehicle.VehicleLabel)) return false;
			}
			else if (!Reader.Skip(Wire))
			{
				return false;
			}
		}
		return true;
	}

	// message Position { latitude = 1; longitude = 2; bearing = 3; odometer = 4; speed = 5; }
	bool ParsePosition(FReader Reader, FVehicleRecord& Vehicle, bool& bOutHasLatitude, bool& bOutHasLongitude)
	{
		while (!Reader.AtEnd())
		{
			uint32_t Field = 0;
			uint32_t Wire = 0;
			if (!Reader.ReadTag(Field, Wire))
			{
				return false;
			}

			if (Field == 1 && Wire == WireFixed32)
			{
				if (!Reader.ReadFloat(Vehicle.Latitude)) return false;
				bOutHasLatitude = true;
			}
			else if (Field == 2 && Wire == WireFixed32)
			{
				if (!Reader.ReadFloat(Vehicle.Longitude)) return false;
				bOutHasLongitude = true;
			}
			else if (Field == 3 && Wire == WireFixed32)
			{
				if (!Reader.ReadFloat(Vehicle.BearingDegrees)) return false;
				Vehicle.bHasBearing = true;
			}
			else if (Field == 5 && Wire == WireFixed32)
			{
				if (!Reader.ReadFloat(Vehicle.SpeedMetersPerSecond)) return false;
				Vehicle.bHasSpeed = true;
			}
			else if (!Reader.Skip(Wire))
			{
				return false;
			}
		}
		return true;
	}

	// message VehiclePosition { trip = 1; position = 2; current_stop_sequence = 3; current_status = 4;
	//                           timestamp = 5; congestion_level = 6; stop_id = 7; vehicle = 8; }
	bool ParseVehiclePosition(FReader Reader, FVehicleRecord& Vehicle, bool& bOutHasPosition)
	{
		bool bHasLatitude = false;
		bool bHasLongitude = false;

		while (!Reader.AtEnd())
		{
			uint32_t Field = 0;
			uint32_t Wire = 0;
			if (!Reader.ReadTag(Field, Wire))
			{
				return false;
			}

			if (Field == 1 && Wire == WireLengthDelimited)
			{
				FReader Sub;
				if (!Reader.ReadSubMessage(Sub) || !ParseTrip(Sub, Vehicle)) return false;
			}
			else if (Field == 2 && Wire == WireLengthDelimited)
			{
				FReader Sub;
				if (!Reader.ReadSubMessage(Sub) || !ParsePosition(Sub, Vehicle, bHasLatitude, bHasLongitude)) return false;
			}
			else if (Field == 4 && Wire == WireVarint)
			{
				uint64_t Value = 0;
				if (!Reader.ReadVarint(Value)) return false;
				Vehicle.CurrentStatus = static_cast<int32_t>(Value);
			}
			else if (Field == 5 && Wire == WireVarint)
			{
				if (!Reader.ReadVarint(Vehicle.Timestamp)) return false;
			}
			else if (Field == 7 && Wire == WireLengthDelimited)
			{
				if (!Reader.ReadString(Vehicle.StopId)) return false;
			}
			else if (Field == 8 && Wire == WireLengthDelimited)
			{
				FReader Sub;
				if (!Reader.ReadSubMessage(Sub) || !ParseVehicleDescriptor(Sub, Vehicle)) return false;
			}
			else if (!Reader.Skip(Wire))
			{
				return false;
			}
		}

		bOutHasPosition = bHasLatitude && bHasLongitude;
		return true;
	}

	// message FeedEntity { id = 1; is_deleted = 2; trip_update = 3; vehicle = 4; alert = 5; }
	bool ParseEntity(FReader Reader, FFeed& Feed)
	{
		FVehicleRecord Vehicle;
		bool bHasVehicle = false;
		bool bHasPosition = false;
		bool bIsDeleted = false;

		while (!Reader.AtEnd())
		{
			uint32_t Field = 0;
			uint32_t Wire = 0;
			if (!Reader.ReadTag(Field, Wire))
			{
				return false;
			}

			if (Field == 1 && Wire == WireLengthDelimited)
			{
				if (!Reader.ReadString(Vehicle.EntityId)) return false;
			}
			else if (Field == 2 && Wire == WireVarint)
			{
				uint64_t Value = 0;
				if (!Reader.ReadVarint(Value)) return false;
				bIsDeleted = Value != 0;
			}
			else if (Field == 4 && Wire == WireLengthDelimited)
			{
				FReader Sub;
				if (!Reader.ReadSubMessage(Sub) || !ParseVehiclePosition(Sub, Vehicle, bHasPosition)) return false;
				bHasVehicle = true;
			}
			else if (!Reader.Skip(Wire))
			{
				return false;
			}
		}

		if (bHasVehicle && bHasPosition && !bIsDeleted)
		{
			Feed.Vehicles.push_back(std::move(Vehicle));
		}
		return true;
	}

	// message FeedHeader { gtfs_realtime_version = 1; incrementality = 2; timestamp = 3; }
	bool ParseHeader(FReader Reader, FFeed& Feed)
	{
		while (!Reader.AtEnd())
		{
			uint32_t Field = 0;
			uint32_t Wire = 0;
			if (!Reader.ReadTag(Field, Wire))
			{
				return false;
			}

			if (Field == 3 && Wire == WireVarint)
			{
				if (!Reader.ReadVarint(Feed.HeaderTimestamp)) return false;
			}
			else if (!Reader.Skip(Wire))
			{
				return false;
			}
		}
		return true;
	}
}

bool DecodeVehiclePositions(const uint8_t* Data, size_t Size, FFeed& OutFeed)
{
	OutFeed = FFeed();
	if (Data == nullptr)
	{
		return Size == 0;
	}

	// message FeedMessage { header = 1; entity = 2 (repeated); }
	FReader Reader(Data, Size);
	while (!Reader.AtEnd())
	{
		uint32_t Field = 0;
		uint32_t Wire = 0;
		if (!Reader.ReadTag(Field, Wire))
		{
			return false;
		}

		if (Field == 1 && Wire == WireLengthDelimited)
		{
			FReader Sub;
			if (!Reader.ReadSubMessage(Sub) || !ParseHeader(Sub, OutFeed)) return false;
		}
		else if (Field == 2 && Wire == WireLengthDelimited)
		{
			FReader Sub;
			if (!Reader.ReadSubMessage(Sub) || !ParseEntity(Sub, OutFeed)) return false;
		}
		else if (!Reader.Skip(Wire))
		{
			return false;
		}
	}
	return true;
}
}
