#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "Npc/NpcCharacter.h"
#include "BudapestWorldSettings.generated.h"

/** Project Settings > Game > Budapest World. Stored per user in Saved/Config unless you copy values into DefaultGame.ini. */
UCLASS(Config = Game)
class BUDAPESTSIM_API UBudapestWorldSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	virtual FName GetCategoryName() const override { return TEXT("Game"); }

#if WITH_EDITOR
	virtual FText GetSectionText() const override { return NSLOCTEXT("BudapestSim", "WorldSettingsSection", "Budapest World"); }
#endif

	// --- Baked district data (relative to the project's Content folder) ---

	UPROPERTY(Config, EditAnywhere, Category = "Data")
	FString BuildingsFile = TEXT("Data/district8_buildings.bsb");

	UPROPERTY(Config, EditAnywhere, Category = "Data")
	FString PathsFile = TEXT("Data/district8_paths.bsb");

	// --- Day cycle ---

	/** 1 = real time (a Budapest day lasts 24 real hours). 60 = one game minute per real second, and so on. */
	UPROPERTY(Config, EditAnywhere, Category = "Day Cycle", meta = (ClampMin = "0.0", ClampMax = "7200.0"))
	float TimeScale = 1.0f;

	/** Start the clock at the actual current time in Budapest (daylight saving included). */
	UPROPERTY(Config, EditAnywhere, Category = "Day Cycle")
	bool bStartAtRealBudapestTime = true;

	/** Local Budapest hour to start at when not using real time (0-24). Today's date is kept. */
	UPROPERTY(Config, EditAnywhere, Category = "Day Cycle", meta = (EditCondition = "!bStartAtRealBudapestTime", ClampMin = "0.0", ClampMax = "24.0"))
	float StartLocalHour = 12.0f;

	// --- Pedestrians ---

	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians")
	bool bSpawnPedestrians = true;

	/** People out across the WHOLE district at the busiest time of day. Fewer at night. Simulated cheaply everywhere. */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "0", ClampMax = "20000"))
	int32 MaxDistrictPedestrians = 2500;

	/** At most this many of them are full animated characters at once (the ones closest to the camera). */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "0", ClampMax = "1000"))
	int32 MaxPedestrians = 120;

	/** Within this distance of the camera, pedestrians are full characters. */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "30.0", Units = "m"))
	float PedestrianSpawnRadiusMeters = 150.0f;

	/** A full character further away than this turns back into a lightweight figure (a little more than the spawn radius, to avoid flicker). */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "40.0", Units = "m"))
	float PedestrianDespawnRadiusMeters = 180.0f;

	/** Beyond the character radius and up to this distance, pedestrians are drawn as simple instanced figures. */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "100.0", Units = "m"))
	float PedestrianImpostorRadiusMeters = 1200.0f;

	/**
	 * Character blueprints (children of NpcCharacter) used as pedestrian looks - e.g. MetaHuman-based ones.
	 * With none listed, simple placeholder figures are used. See README, "Realistic pedestrians".
	 */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians")
	TArray<TSoftClassPtr<ANpcCharacter>> PedestrianClasses;

	// --- Transit network (static BKK GTFS: lines, tracks, stops) ---

	/** Baked by Tools/Transit/bake_gtfs.py, relative to the Content folder. */
	UPROPERTY(Config, EditAnywhere, Category = "Transit Network")
	FString TransitFile = TEXT("Data/district8_transit.bsb");

	UPROPERTY(Config, EditAnywhere, Category = "Transit Network")
	bool bShowTramTracks = true;

	UPROPERTY(Config, EditAnywhere, Category = "Transit Network")
	bool bShowBusRoutes = false;

	UPROPERTY(Config, EditAnywhere, Category = "Transit Network")
	bool bShowStops = true;

	/** Keep live trams and buses on their real route line instead of raw (noisy) GPS positions. */
	UPROPERTY(Config, EditAnywhere, Category = "Transit Network")
	bool bSnapVehiclesToRoutes = true;

	// --- City detail ---

	/** Windows, ground-floor band and cornices on building walls; some windows light up at night. */
	UPROPERTY(Config, EditAnywhere, Category = "City")
	bool bFacadeDetail = true;

	/** Solid buildings: the player and bullets cannot pass through walls. */
	UPROPERTY(Config, EditAnywhere, Category = "City")
	bool bBuildingCollision = true;

	UPROPERTY(Config, EditAnywhere, Category = "City")
	bool bStreetLamps = true;

	UPROPERTY(Config, EditAnywhere, Category = "City", meta = (ClampMin = "10.0", Units = "m"))
	float StreetLampSpacingMeters = 32.0f;

	/** Real lights are expensive: only the lamps nearest the camera actually cast light. */
	UPROPERTY(Config, EditAnywhere, Category = "City", meta = (ClampMin = "0", ClampMax = "256"))
	int32 MaxLampLights = 48;

	// --- Player ---

	/** Start the game walking at street level (with weapons). Otherwise start in the flying camera. */
	UPROPERTY(Config, EditAnywhere, Category = "Player")
	bool bStartOnFoot = true;
};
