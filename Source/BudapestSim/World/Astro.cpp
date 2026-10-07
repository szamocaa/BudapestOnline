#include "World/Astro.h"

#include <cmath>

namespace Astro
{
namespace
{
	constexpr double Pi = 3.14159265358979323846;
	constexpr double DegToRad = Pi / 180.0;
	constexpr double RadToDeg = 180.0 / Pi;

	double WrapDegrees360(double Degrees)
	{
		double Result = std::fmod(Degrees, 360.0);
		if (Result < 0.0)
		{
			Result += 360.0;
		}
		return Result;
	}

	double JulianDay(double UnixSeconds)
	{
		return UnixSeconds / 86400.0 + 2440587.5;
	}

	// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
	int64_t DaysFromCivil(int64_t Year, int Month, int Day)
	{
		Year -= Month <= 2 ? 1 : 0;
		const int64_t Era = (Year >= 0 ? Year : Year - 399) / 400;
		const int64_t YearOfEra = Year - Era * 400;
		const int64_t DayOfYear = (153 * (Month + (Month > 2 ? -3 : 9)) + 2) / 5 + Day - 1;
		const int64_t DayOfEra = YearOfEra * 365 + YearOfEra / 4 - YearOfEra / 100 + DayOfYear;
		return Era * 146097 + DayOfEra - 719468;
	}

	void CivilFromDays(int64_t Days, int64_t& OutYear, int& OutMonth, int& OutDay)
	{
		Days += 719468;
		const int64_t Era = (Days >= 0 ? Days : Days - 146096) / 146097;
		const int64_t DayOfEra = Days - Era * 146097;
		const int64_t YearOfEra = (DayOfEra - DayOfEra / 1460 + DayOfEra / 36524 - DayOfEra / 146096) / 365;
		const int64_t DayOfYear = DayOfEra - (365 * YearOfEra + YearOfEra / 4 - YearOfEra / 100);
		const int64_t MonthPrime = (5 * DayOfYear + 2) / 153;
		OutDay = static_cast<int>(DayOfYear - (153 * MonthPrime + 2) / 5 + 1);
		OutMonth = static_cast<int>(MonthPrime < 10 ? MonthPrime + 3 : MonthPrime - 9);
		OutYear = YearOfEra + Era * 400 + (OutMonth <= 2 ? 1 : 0);
	}

	// Greenwich mean sidereal time in degrees.
	double GreenwichSiderealDegrees(double JulianDayValue)
	{
		const double T = (JulianDayValue - 2451545.0) / 36525.0;
		return WrapDegrees360(280.46061837 + 360.98564736629 * (JulianDayValue - 2451545.0) + 0.000387933 * T * T);
	}

	// Equatorial (right ascension, declination; radians) -> horizontal for an observer.
	FSkyBody ToHorizontal(double RightAscension, double Declination, double JulianDayValue, double LatitudeDegrees, double LongitudeDegrees)
	{
		const double HourAngle = (GreenwichSiderealDegrees(JulianDayValue) + LongitudeDegrees) * DegToRad - RightAscension;
		const double Latitude = LatitudeDegrees * DegToRad;

		const double SinElevation = std::sin(Latitude) * std::sin(Declination) + std::cos(Latitude) * std::cos(Declination) * std::cos(HourAngle);
		FSkyBody Result;
		Result.ElevationDegrees = std::asin(std::fmax(-1.0, std::fmin(1.0, SinElevation))) * RadToDeg;
		// Azimuth measured from north through east: atan2 over (west-positive hour angle) shifted by 180 degrees.
		const double Azimuth = std::atan2(std::sin(HourAngle), std::cos(HourAngle) * std::sin(Latitude) - std::tan(Declination) * std::cos(Latitude));
		Result.AzimuthDegrees = WrapDegrees360(Azimuth * RadToDeg + 180.0);
		return Result;
	}

	struct FEquatorial
	{
		double RightAscension = 0.0;
		double Declination = 0.0;
	};

	// Sun's apparent equatorial coordinates (Meeus, "Astronomical Algorithms", ch. 25 low-accuracy).
	FEquatorial SunEquatorial(double JulianDayValue)
	{
		const double T = (JulianDayValue - 2451545.0) / 36525.0;
		const double MeanLongitude = WrapDegrees360(280.46646 + T * (36000.76983 + T * 0.0003032));
		const double MeanAnomaly = (357.52911 + T * (35999.05029 - T * 0.0001537)) * DegToRad;
		const double Center = std::sin(MeanAnomaly) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
			std::sin(2.0 * MeanAnomaly) * (0.019993 - 0.000101 * T) + std::sin(3.0 * MeanAnomaly) * 0.000289;
		const double TrueLongitude = MeanLongitude + Center;
		const double Omega = (125.04 - 1934.136 * T) * DegToRad;
		const double ApparentLongitude = (TrueLongitude - 0.00569 - 0.00478 * std::sin(Omega)) * DegToRad;
		const double MeanObliquity = 23.0 + (26.0 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60.0) / 60.0;
		const double Obliquity = (MeanObliquity + 0.00256 * std::cos(Omega)) * DegToRad;

		FEquatorial Result;
		Result.RightAscension = std::atan2(std::cos(Obliquity) * std::sin(ApparentLongitude), std::cos(ApparentLongitude));
		Result.Declination = std::asin(std::sin(Obliquity) * std::sin(ApparentLongitude));
		return Result;
	}

	// Last Sunday of the month at 01:00 UTC, as unix seconds.
	int64_t LastSundayAtOneUtc(int64_t Year, int Month)
	{
		const int NextMonth = Month == 12 ? 1 : Month + 1;
		const int64_t NextMonthYear = Month == 12 ? Year + 1 : Year;
		const int64_t LastDay = DaysFromCivil(NextMonthYear, NextMonth, 1) - 1;
		// 1970-01-01 was a Thursday; (Days + 4) % 7 gives 0 for Sunday.
		const int64_t WeekDay = ((LastDay + 4) % 7 + 7) % 7;
		return (LastDay - WeekDay) * 86400 + 3600;
	}
}

FSkyBody SunPosition(double UnixSeconds, double LatitudeDegrees, double LongitudeDegrees)
{
	const double JulianDayValue = JulianDay(UnixSeconds);
	const FEquatorial Sun = SunEquatorial(JulianDayValue);
	return ToHorizontal(Sun.RightAscension, Sun.Declination, JulianDayValue, LatitudeDegrees, LongitudeDegrees);
}

FMoon MoonPosition(double UnixSeconds, double LatitudeDegrees, double LongitudeDegrees)
{
	const double JulianDayValue = JulianDay(UnixSeconds);
	const double T = (JulianDayValue - 2451545.0) / 36525.0;

	// Fundamental arguments (Meeus ch. 47): mean longitude, elongation, sun anomaly, moon anomaly, node distance.
	const double MeanLongitude = WrapDegrees360(218.3164477 + 481267.88123421 * T);
	const double Elongation = WrapDegrees360(297.8501921 + 445267.1114034 * T) * DegToRad;
	const double SunAnomaly = WrapDegrees360(357.5291092 + 35999.0502909 * T) * DegToRad;
	const double MoonAnomaly = WrapDegrees360(134.9633964 + 477198.8675055 * T) * DegToRad;
	const double NodeDistance = WrapDegrees360(93.2720950 + 483202.0175233 * T) * DegToRad;

	// Largest periodic terms only: good to roughly 0.3 degrees, ample for placing a moon in the sky.
	const double EclipticLongitude = (MeanLongitude + 6.289 * std::sin(MoonAnomaly) + 1.274 * std::sin(2.0 * Elongation - MoonAnomaly) +
		0.658 * std::sin(2.0 * Elongation) + 0.214 * std::sin(2.0 * MoonAnomaly) - 0.186 * std::sin(SunAnomaly) - 0.114 * std::sin(2.0 * NodeDistance)) * DegToRad;
	const double EclipticLatitude = (5.128 * std::sin(NodeDistance) + 0.281 * std::sin(MoonAnomaly + NodeDistance) +
		0.278 * std::sin(MoonAnomaly - NodeDistance) + 0.173 * std::sin(2.0 * Elongation - NodeDistance)) * DegToRad;
	const double DistanceKm = 385001.0 - 20905.0 * std::cos(MoonAnomaly);
	const double Obliquity = (23.4392911 - 0.0130042 * T) * DegToRad;

	const double RightAscension = std::atan2(std::sin(EclipticLongitude) * std::cos(Obliquity) - std::tan(EclipticLatitude) * std::sin(Obliquity), std::cos(EclipticLongitude));
	const double Declination = std::asin(std::sin(EclipticLatitude) * std::cos(Obliquity) + std::cos(EclipticLatitude) * std::sin(Obliquity) * std::sin(EclipticLongitude));

	FMoon Moon;
	const FSkyBody Horizontal = ToHorizontal(RightAscension, Declination, JulianDayValue, LatitudeDegrees, LongitudeDegrees);
	// Parallax: the moon is close enough that the observer's position shifts it by up to ~1 degree.
	const double HorizontalParallax = std::asin(6378.14 / DistanceKm);
	Moon.ElevationDegrees = Horizontal.ElevationDegrees - HorizontalParallax * RadToDeg * std::cos(Horizontal.ElevationDegrees * DegToRad);
	Moon.AzimuthDegrees = Horizontal.AzimuthDegrees;

	// Phase from the sun-moon angular separation (the sun's distance dwarfs the moon's).
	const FEquatorial Sun = SunEquatorial(JulianDayValue);
	const double CosSeparation = std::sin(Sun.Declination) * std::sin(Declination) +
		std::cos(Sun.Declination) * std::cos(Declination) * std::cos(Sun.RightAscension - RightAscension);
	Moon.IlluminatedFraction = (1.0 - std::fmax(-1.0, std::fmin(1.0, CosSeparation))) * 0.5;
	return Moon;
}

int64_t UnixFromUtc(int Year, int Month, int Day, int Hour, int Minute, int Second)
{
	return DaysFromCivil(Year, Month, Day) * 86400 + Hour * 3600 + Minute * 60 + Second;
}

int BudapestUtcOffsetHours(int64_t UnixSeconds)
{
	// Floor division so instants before 1970 still land on the right civil year.
	const int64_t Days = UnixSeconds >= 0 ? UnixSeconds / 86400 : -((-UnixSeconds + 86399) / 86400);
	int64_t Year = 0;
	int Month = 0;
	int Day = 0;
	CivilFromDays(Days, Year, Month, Day);

	const int64_t SummerStart = LastSundayAtOneUtc(Year, 3);
	const int64_t SummerEnd = LastSundayAtOneUtc(Year, 10);
	return (UnixSeconds >= SummerStart && UnixSeconds < SummerEnd) ? 2 : 1;
}

double BudapestLocalHours(double UnixSeconds)
{
	const int64_t Whole = static_cast<int64_t>(std::floor(UnixSeconds));
	const double Local = UnixSeconds + 3600.0 * BudapestUtcOffsetHours(Whole);
	double SecondsOfDay = std::fmod(Local, 86400.0);
	if (SecondsOfDay < 0.0)
	{
		SecondsOfDay += 86400.0;
	}
	return SecondsOfDay / 3600.0;
}
}
