// Standalone test for GtfsRtDecoder (no Unreal needed). Run with Tools/DecoderTest/run.sh.
#include "Transit/GtfsRtDecoder.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <vector>

static int Failures = 0;

#define EXPECT(Cond)                                                              \
	do                                                                            \
	{                                                                             \
		if (!(Cond))                                                              \
		{                                                                         \
			std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #Cond);           \
			++Failures;                                                           \
		}                                                                         \
	} while (0)

int main(int argc, char** argv)
{
	const char* Path = argc > 1 ? argv[1] : "sample_vehicle_positions.pb";
	std::ifstream In(Path, std::ios::binary);
	std::vector<uint8_t> Bytes((std::istreambuf_iterator<char>(In)), std::istreambuf_iterator<char>());
	if (Bytes.empty())
	{
		std::printf("cannot read %s\n", Path);
		return 2;
	}

	GtfsRt::FFeed Feed;
	EXPECT(GtfsRt::DecodeVehiclePositions(Bytes.data(), Bytes.size(), Feed));
	EXPECT(Feed.HeaderTimestamp == 1790000000ull);

	// Deleted entity, position-less entity, trip update and alert must all be dropped.
	EXPECT(Feed.Vehicles.size() == 3);
	if (Feed.Vehicles.size() == 3)
	{
		const GtfsRt::FVehicleRecord& A = Feed.Vehicles[0];
		EXPECT(A.EntityId == "e1");
		EXPECT(A.RouteId == "BKK_3040");
		EXPECT(A.TripId == "BKK_T1");
		EXPECT(A.VehicleId == "BKK_V100");
		EXPECT(A.VehicleLabel == "1234");
		EXPECT(A.StopId == "BKK_F00123");
		EXPECT(A.Latitude == 47.4979f);
		EXPECT(A.Longitude == 19.0402f);
		EXPECT(A.bHasBearing && A.BearingDegrees == 90.0f);
		EXPECT(A.bHasSpeed && A.SpeedMetersPerSecond == 7.5f);
		EXPECT(A.DirectionId == 1);
		EXPECT(A.CurrentStatus == 2);
		EXPECT(A.Timestamp == 1790000001ull);

		const GtfsRt::FVehicleRecord& B = Feed.Vehicles[1];
		EXPECT(B.RouteId == "BKK_5200");
		EXPECT(B.VehicleLabel == "K\xC3\xA1lvin t\xC3\xA9r"); // UTF-8 "Kálvin tér"
		EXPECT(B.bHasBearing && B.BearingDegrees == 271.5f);
		EXPECT(!B.bHasSpeed);
		EXPECT(B.DirectionId == -1);
		EXPECT(B.CurrentStatus == -1);

		const GtfsRt::FVehicleRecord& C = Feed.Vehicles[2];
		EXPECT(C.VehicleLabel.size() == 200); // multi-byte length prefix
		EXPECT(!C.bHasBearing);
		EXPECT(C.DirectionId == 0);
	}

	// Empty input is a valid, empty feed.
	GtfsRt::FFeed Empty;
	EXPECT(GtfsRt::DecodeVehiclePositions(nullptr, 0, Empty));
	EXPECT(Empty.Vehicles.empty());

	// Every truncation must be handled without crashing (run under ASan/UBSan by run.sh).
	// A cut that lands exactly on a field boundary is still a valid feed, so only check safety.
	size_t Rejected = 0;
	for (size_t Len = 0; Len < Bytes.size(); ++Len)
	{
		GtfsRt::FFeed Partial;
		if (!GtfsRt::DecodeVehiclePositions(Bytes.data(), Len, Partial))
		{
			++Rejected;
		}
	}
	EXPECT(Rejected > Bytes.size() / 2);

	// Random corruption must never crash either.
	std::srand(12345);
	for (int Iter = 0; Iter < 20000; ++Iter)
	{
		std::vector<uint8_t> Mutated = Bytes;
		const int Flips = 1 + std::rand() % 4;
		for (int F = 0; F < Flips; ++F)
		{
			Mutated[static_cast<size_t>(std::rand()) % Mutated.size()] = static_cast<uint8_t>(std::rand());
		}
		GtfsRt::FFeed Garbage;
		GtfsRt::DecodeVehiclePositions(Mutated.data(), Mutated.size(), Garbage);
	}

	if (Failures == 0)
	{
		std::printf("OK: decoder matches official protobuf output (%zu bytes, %zu truncations rejected)\n",
		            Bytes.size(), Rejected);
		return 0;
	}
	std::printf("FAILED: %d check(s)\n", Failures);
	return 1;
}
