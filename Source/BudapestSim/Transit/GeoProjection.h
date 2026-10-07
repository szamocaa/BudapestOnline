#pragma once

#include "CoreMinimal.h"

/**
 * Flat local projection of WGS84 coordinates around an origin. Accurate to well under 1% within
 * the ~30 km that Budapest spans, which is plenty for placing vehicles.
 *
 * World axes: +X = north, +Y = east, +Z = up. Seen from above that matches a map, and it is a
 * valid left-handed Unreal frame, so a compass bearing maps straight onto actor yaw.
 * World units are centimetres.
 */
namespace BudapestGeo
{
	constexpr double EarthRadiusMeters = 6371008.8;
	constexpr double DegreesToRadians = 3.14159265358979323846 / 180.0;
	constexpr double MetersToWorldUnits = 100.0;

	/** Rough centre of Budapest's VIII. district (Jozsefvaros); the world origin sits here. */
	constexpr double DefaultOriginLatitude = 47.4925;
	constexpr double DefaultOriginLongitude = 19.0800;

	/** Padded bounding box around the VIII. district. Approximate; used to cull vehicles outside the area we model. */
	namespace DistrictVIII
	{
		constexpr double MinLatitude = 47.4780;
		constexpr double MaxLatitude = 47.5060;
		constexpr double MinLongitude = 19.0540;
		constexpr double MaxLongitude = 19.1060;

		inline bool Contains(double Latitude, double Longitude, double MarginDegrees = 0.0)
		{
			return Latitude >= MinLatitude - MarginDegrees && Latitude <= MaxLatitude + MarginDegrees &&
				Longitude >= MinLongitude - MarginDegrees && Longitude <= MaxLongitude + MarginDegrees;
		}
	}

	inline FVector LatLonToWorld(double Latitude, double Longitude, double OriginLatitude, double OriginLongitude, double HeightWorldUnits = 0.0)
	{
		const double NorthMeters = (Latitude - OriginLatitude) * DegreesToRadians * EarthRadiusMeters;
		const double EastMeters = (Longitude - OriginLongitude) * DegreesToRadians * EarthRadiusMeters * FMath::Cos(OriginLatitude * DegreesToRadians);
		return FVector(NorthMeters * MetersToWorldUnits, EastMeters * MetersToWorldUnits, HeightWorldUnits);
	}

	/** Inverse of LatLonToWorld for offsets given in metres. */
	inline void OffsetLatLon(double OriginLatitude, double OriginLongitude, double NorthMeters, double EastMeters, double& OutLatitude, double& OutLongitude)
	{
		OutLatitude = OriginLatitude + NorthMeters / (EarthRadiusMeters * DegreesToRadians);
		OutLongitude = OriginLongitude + EastMeters / (EarthRadiusMeters * DegreesToRadians * FMath::Cos(OriginLatitude * DegreesToRadians));
	}
}
