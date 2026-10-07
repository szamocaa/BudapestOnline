// Minimal GTFS-realtime (protobuf) decoder for VehiclePositions feeds.
//
// Deliberately free of Unreal types so it can be compiled and tested outside the engine
// (see Tools/DecoderTest). It reads the protobuf wire format directly, which avoids shipping
// a full protobuf runtime for the handful of fields we need.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace GtfsRt
{
	struct FVehicleRecord
	{
		std::string EntityId;
		std::string TripId;
		std::string RouteId;
		std::string VehicleId;
		std::string VehicleLabel;
		std::string StopId;

		float Latitude = 0.0f;
		float Longitude = 0.0f;
		float BearingDegrees = 0.0f;
		float SpeedMetersPerSecond = 0.0f;

		bool bHasBearing = false;
		bool bHasSpeed = false;

		int32_t DirectionId = -1;
		// 0 = incoming at stop, 1 = stopped at stop, 2 = in transit to stop, -1 = unknown.
		int32_t CurrentStatus = -1;
		uint64_t Timestamp = 0;
	};

	struct FFeed
	{
		uint64_t HeaderTimestamp = 0;
		std::vector<FVehicleRecord> Vehicles;
	};

	// Decodes a FeedMessage and collects every entity that carries a vehicle position with
	// coordinates. Entities flagged is_deleted and entities without a position are skipped.
	// Returns false if the buffer is malformed or truncated; OutFeed then holds whatever was
	// decoded before the error and should be discarded by the caller.
	bool DecodeVehiclePositions(const uint8_t* Data, size_t Size, FFeed& OutFeed);
}
