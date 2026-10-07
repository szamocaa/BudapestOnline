#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "DayCycleActor.generated.h"

class UDirectionalLightComponent;
class UExponentialHeightFogComponent;
class UPostProcessComponent;
class USceneComponent;
class USkyAtmosphereComponent;
class USkyLightComponent;

/**
 * Runs the sky for a real 24-hour Budapest day: the sun and moon sit where they really are for
 * Budapest's latitude/longitude at the simulated date and time (see World/Astro.h), including
 * seasons, twilight, moon phase and daylight-saving time.
 */
UCLASS()
class BUDAPESTSIM_API ADayCycleActor : public AActor
{
	GENERATED_BODY()

public:
	ADayCycleActor();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	/** Local Budapest time of day, 0-24. */
	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	float GetLocalHours() const;

	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	float GetSunElevationDegrees() const { return SunElevationDegrees; }

	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	bool IsDaytime() const { return SunElevationDegrees > 0.0f; }

	/** e.g. "21:07 CEST, 07 Oct 2026". */
	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	FString GetClockString() const;

	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	void SetTimeScale(float NewTimeScale);

	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	float GetTimeScale() const { return TimeScale; }

	/** Jumps to the given local hour (0-24) on the current Budapest date. */
	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	void SetLocalHour(float Hour);

	UFUNCTION(BlueprintCallable, Category = "Day Cycle")
	void SyncToRealTime();

	/** Sun illuminance used at full day. Moon and sky are scaled relative to it; tune to taste. */
	UPROPERTY(EditAnywhere, Category = "Day Cycle")
	float SunIntensity = 10.0f;

	UPROPERTY(EditAnywhere, Category = "Day Cycle")
	float MoonMaxIntensity = 0.4f;

protected:
	UPROPERTY(VisibleAnywhere, Category = "Day Cycle")
	TObjectPtr<USceneComponent> Root;

	UPROPERTY(VisibleAnywhere, Category = "Day Cycle")
	TObjectPtr<UDirectionalLightComponent> Sun;

	UPROPERTY(VisibleAnywhere, Category = "Day Cycle")
	TObjectPtr<UDirectionalLightComponent> Moon;

	UPROPERTY(VisibleAnywhere, Category = "Day Cycle")
	TObjectPtr<USkyAtmosphereComponent> Atmosphere;

	UPROPERTY(VisibleAnywhere, Category = "Day Cycle")
	TObjectPtr<USkyLightComponent> SkyLight;

	UPROPERTY(VisibleAnywhere, Category = "Day Cycle")
	TObjectPtr<UExponentialHeightFogComponent> Fog;

	UPROPERTY(VisibleAnywhere, Category = "Day Cycle")
	TObjectPtr<UPostProcessComponent> Exposure;

private:
	void ApplySky();

	/** Simulated time as Unix seconds (UTC). */
	double SimUnixSeconds = 0.0;
	float TimeScale = 1.0f;
	float SecondsSinceSkyUpdate = 1000.0f;
	float SunElevationDegrees = 0.0f;
};
