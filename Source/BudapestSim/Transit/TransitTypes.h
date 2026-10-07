#pragma once

#include "CoreMinimal.h"
#include "TransitTypes.generated.h"

UENUM(BlueprintType)
enum class ETransitMode : uint8
{
	Unknown,
	Tram,
	Metro,
	Bus,
	Trolleybus,
	SuburbanRail,
	Ferry
};

/** One vehicle as reported by the live (or mock) feed, already converted to engine types. */
USTRUCT(BlueprintType)
struct FTransitVehicleState
{
	GENERATED_BODY()

	/** Stable key for this vehicle across updates (feed vehicle id, falling back to entity id). */
	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	FString VehicleId;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	FString Label;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	FString RouteId;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	FString TripId;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	double Latitude = 0.0;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	double Longitude = 0.0;

	/** Degrees clockwise from north. Only meaningful when bHasBearing is true. */
	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	float BearingDegrees = 0.0f;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	bool bHasBearing = false;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	float SpeedMetersPerSecond = 0.0f;

	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	ETransitMode Mode = ETransitMode::Unknown;

	/** Unix time (seconds) of the position fix, 0 if the feed did not say. */
	UPROPERTY(BlueprintReadOnly, Category = "Transit")
	int64 Timestamp = 0;
};
