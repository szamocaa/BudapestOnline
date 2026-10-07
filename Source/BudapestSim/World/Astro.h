// Sun/moon position and Budapest clock helpers. Free of Unreal types so it can be unit-tested
// outside the engine (see Tools/CoreTests).
#pragma once

#include <cstdint>

namespace Astro
{
	struct FSkyBody
	{
		double ElevationDegrees = 0.0; // above the horizon, negative when below
		double AzimuthDegrees = 0.0;   // clockwise from true north, [0, 360)
	};

	struct FMoon : FSkyBody
	{
		double IlluminatedFraction = 0.0; // 0 = new moon, 1 = full moon
	};

	// Unix time is seconds since 1970-01-01T00:00:00Z (fractional allowed).
	// Accuracy: sun ~0.02 degrees, moon ~0.5 degrees (low-precision series), no refraction applied.
	FSkyBody SunPosition(double UnixSeconds, double LatitudeDegrees, double LongitudeDegrees);
	FMoon MoonPosition(double UnixSeconds, double LatitudeDegrees, double LongitudeDegrees);

	// Hours Budapest local time is ahead of UTC at the given instant: 1 (CET) or 2 (CEST).
	// EU rule: summer time runs from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC.
	int BudapestUtcOffsetHours(int64_t UnixSeconds);

	// Local wall-clock time of day in hours [0, 24) for Budapest.
	double BudapestLocalHours(double UnixSeconds);

	// Unix time for a civil date/time in UTC (proleptic Gregorian).
	int64_t UnixFromUtc(int Year, int Month, int Day, int Hour, int Minute, int Second);
}
