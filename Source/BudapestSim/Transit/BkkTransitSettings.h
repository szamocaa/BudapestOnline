#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "Transit/GeoProjection.h"
#include "BkkTransitSettings.generated.h"

/**
 * Project Settings > Game > Budapest Transit.
 *
 * Config=Game without DefaultConfig on purpose: values edited in the editor are written to
 * Saved/Config (git-ignored), so your API key never ends up in the repository.
 */
UCLASS(Config = Game)
class BUDAPESTSIM_API UBkkTransitSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UBkkTransitSettings();

	virtual FName GetCategoryName() const override { return TEXT("Game"); }

#if WITH_EDITOR
	virtual FText GetSectionText() const override { return NSLOCTEXT("BudapestSim", "BkkSettingsSection", "Budapest Transit"); }
#endif

	/**
	 * Key from https://opendata.bkk.hu. Looked up in this order: the BKK_API_KEY environment variable,
	 * this field, then a text file named ApiKeyFileName in the project folder (git-ignored).
	 */
	UPROPERTY(Config, EditAnywhere, Category = "BKK API")
	FString ApiKey;

	/** Plain-text file in the project folder that holds just the key. Easiest option: create it and paste the key in. */
	UPROPERTY(Config, EditAnywhere, Category = "BKK API")
	FString ApiKeyFileName = TEXT("BkkApiKey.txt");

	/**
	 * GTFS-realtime VehiclePositions URL. {key} is replaced with the (URL-encoded) API key.
	 * NOTE: this default has not been verified against BKK's current documentation - check it on
	 * opendata.bkk.hu and run Tools/check_bkk_feed.sh before relying on it.
	 */
	UPROPERTY(Config, EditAnywhere, Category = "BKK API")
	FString VehiclePositionsUrlTemplate;

	/** If BKK expects the key in a request header instead of the URL, put the header name here. */
	UPROPERTY(Config, EditAnywhere, Category = "BKK API")
	FString ApiKeyHeaderName;

	UPROPERTY(Config, EditAnywhere, Category = "BKK API", meta = (ClampMin = "5.0", Units = "s"))
	float PollIntervalSeconds = 10.0f;

	/** Show simulated vehicles even when an API key is present. Without a key the mock feed is always used. */
	UPROPERTY(Config, EditAnywhere, Category = "BKK API")
	bool bForceMockFeed = false;

	/** Latitude/longitude that maps to the world origin. */
	UPROPERTY(Config, EditAnywhere, Category = "World")
	double OriginLatitude = BudapestGeo::DefaultOriginLatitude;

	UPROPERTY(Config, EditAnywhere, Category = "World")
	double OriginLongitude = BudapestGeo::DefaultOriginLongitude;

	/** API key from the environment if present, else from the settings. Empty if neither is set. */
	FString ResolveApiKey() const;
};
