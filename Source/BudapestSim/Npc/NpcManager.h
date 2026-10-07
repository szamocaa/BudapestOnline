#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "City/PedestrianGraph.h"
#include "NpcManager.generated.h"

class ADayCycleActor;
class ANpcCharacter;

/**
 * Keeps a crowd of pedestrians around the player. The population follows the time of day (a
 * handful at 3 am, the rush hours and lunch peak by day) and only exists near the camera, so
 * the cost stays flat however big the district is.
 */
UCLASS()
class BUDAPESTSIM_API ANpcManager : public AActor
{
	GENERATED_BODY()

public:
	ANpcManager();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	const FPedestrianGraph& GetGraph() const { return Graph; }
	int32 GetActiveCount() const { return Npcs.Num(); }

	/**
	 * Next street junction for a walker who came from `From` and is now at `Current`. Avoids turning
	 * back unless at a dead end, and favours busier streets. Returns INDEX_NONE if `Current` has no neighbours.
	 */
	int32 PickNextNode(int32 From, int32 Current, FRandomStream& Random) const;

	/** Fraction (0-1) of MaxPedestrians that are out at a local Budapest hour (0-24). A plausible daily rhythm, not measured data. */
	static float DensityForHour(float Hour);

private:
	void UpdatePopulation();
	bool SpawnOne(const FVector& Center, float MinDistance, float MaxDistance);

	FPedestrianGraph Graph;
	FRandomStream Random;

	UPROPERTY(Transient)
	TArray<TObjectPtr<ANpcCharacter>> Npcs;

	UPROPERTY(Transient)
	TArray<TSubclassOf<ANpcCharacter>> LookClasses;

	TWeakObjectPtr<ADayCycleActor> DayCycle;
	int32 NextSeed = 1;
};
