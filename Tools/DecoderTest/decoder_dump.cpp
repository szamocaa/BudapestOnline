// Prints what the project's GTFS-realtime decoder makes of a saved feed (used by Tools/check_bkk_feed.sh).
#include "Transit/GtfsRtDecoder.h"

#include <cstdio>
#include <fstream>
#include <iterator>
#include <vector>

int main(int argc, char** argv)
{
	if (argc < 2)
	{
		std::printf("usage: decoder_dump <feed.pb>\n");
		return 2;
	}
	std::ifstream In(argv[1], std::ios::binary);
	std::vector<uint8_t> Bytes((std::istreambuf_iterator<char>(In)), std::istreambuf_iterator<char>());

	GtfsRt::FFeed Feed;
	if (!GtfsRt::DecodeVehiclePositions(Bytes.data(), Bytes.size(), Feed))
	{
		std::printf("NOT a valid GTFS-realtime protobuf (%zu bytes). If it is text or JSON, the URL points at a different feed format.\n", Bytes.size());
		return 1;
	}

	// Same padded box as BudapestGeo::DistrictVIII in GeoProjection.h.
	int InDistrict = 0;
	for (const GtfsRt::FVehicleRecord& V : Feed.Vehicles)
	{
		if (V.Latitude >= 47.478f && V.Latitude <= 47.506f && V.Longitude >= 19.054f && V.Longitude <= 19.106f) ++InDistrict;
	}

	std::printf("decoded %zu bytes: %zu vehicles with positions, %d inside the VIII. district box, header time %llu\n",
		Bytes.size(), Feed.Vehicles.size(), InDistrict, static_cast<unsigned long long>(Feed.HeaderTimestamp));
	for (size_t I = 0; I < Feed.Vehicles.size() && I < 8; ++I)
	{
		const GtfsRt::FVehicleRecord& V = Feed.Vehicles[I];
		std::printf("  vehicle %-14s route %-12s lat %.5f lon %.5f bearing %s%.0f\n", V.VehicleId.c_str(), V.RouteId.c_str(),
			static_cast<double>(V.Latitude), static_cast<double>(V.Longitude), V.bHasBearing ? "" : "(none) ", static_cast<double>(V.BearingDegrees));
	}
	return 0;
}
