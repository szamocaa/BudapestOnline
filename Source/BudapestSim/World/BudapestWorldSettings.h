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

	/** Population at the busiest time of day. It shrinks at night and during quiet hours. */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "0", ClampMax = "1000"))
	int32 MaxPedestrians = 150;

	/** Pedestrians are kept within this distance of the player camera; others are removed and respawned nearby. */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "50.0", Units = "m"))
	float PedestrianSpawnRadiusMeters = 250.0f;

	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "60.0", Units = "m"))
	float PedestrianDespawnRadiusMeters = 350.0f;

	/**
	 * Character blueprints (children of NpcCharacter) used as pedestrian looks - e.g. MetaHuman-based ones.
	 * With none listed, simple placeholder figures are used. See README, "Realistic pedestrians".
	 */
	UPROPERTY(Config, EditAnywhere, Category = "Pedestrians")
	TArray<TSoftClassPtr<ANpcCharacter>> PedestrianClasses;
};
