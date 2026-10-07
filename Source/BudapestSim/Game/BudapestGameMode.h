#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "BudapestGameMode.generated.h"

class ADayCycleActor;
class ADistrictBuildings;
class ANpcManager;
class ATransitManager;

/**
 * Sets up the whole simulation in whatever level it runs in: the district, sky and clock, live
 * transit and pedestrians. Drop nothing into the level by hand - an empty level works.
 */
UCLASS()
class BUDAPESTSIM_API ABudapestGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	ABudapestGameMode();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

private:
	void ShowStatus() const;

	UPROPERTY(Transient)
	TObjectPtr<ADistrictBuildings> City;

	UPROPERTY(Transient)
	TObjectPtr<ADayCycleActor> DayCycle;

	UPROPERTY(Transient)
	TObjectPtr<ATransitManager> Transit;

	UPROPERTY(Transient)
	TObjectPtr<ANpcManager> Pedestrians;
};
