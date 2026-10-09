#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "BudapestGameMode.generated.h"

class ADayCycleActor;
class ADistrictBuildings;
class ANpcManager;
class AStreetLamps;
class ATransitManager;
class ATransitNetwork;

/**
 * Sets up the whole simulation in whatever level it runs in: the district, sky and clock, transit
 * network and live vehicles, pedestrians and street lamps. An empty level works.
 */
UCLASS()
class BUDAPESTSIM_API ABudapestGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	ABudapestGameMode();

	virtual void BeginPlay() override;

	/** The running game mode's systems (for the HUD and gameplay code). Any of them may be null early in startup. */
	ADayCycleActor* GetDayCycle() const { return DayCycle; }
	ADistrictBuildings* GetCity() const { return City; }
	ATransitNetwork* GetTransitNetwork() const { return TransitNetwork; }
	ATransitManager* GetTransit() const { return Transit; }
	ANpcManager* GetPedestrians() const { return Pedestrians; }
	AStreetLamps* GetStreetLamps() const { return StreetLamps; }

private:
	UPROPERTY(Transient)
	TObjectPtr<ADistrictBuildings> City;

	UPROPERTY(Transient)
	TObjectPtr<ADayCycleActor> DayCycle;

	UPROPERTY(Transient)
	TObjectPtr<ATransitNetwork> TransitNetwork;

	UPROPERTY(Transient)
	TObjectPtr<ATransitManager> Transit;

	UPROPERTY(Transient)
	TObjectPtr<ANpcManager> Pedestrians;

	UPROPERTY(Transient)
	TObjectPtr<AStreetLamps> StreetLamps;
};
