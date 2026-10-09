#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "City/PedestrianGraph.h"
#include "Npc/CrowdSim.h"
#include "NpcManager.generated.h"

class ADayCycleActor;
class ANpcCharacter;
class UInstancedStaticMeshComponent;

/**
 * The pedestrians of the whole VIII. district. Everyone out on the streets is simulated cheaply
 * (Npc/CrowdSim: thousands of walkers on the real street network, numbers following the time of day)
 * and shown with three levels of detail around the camera:
 *  - within PedestrianSpawnRadiusMeters: full animated characters (at most MaxPedestrians, closest first),
 *    which take over the walker's exact position, street, speed and look;
 *  - out to PedestrianImpostorRadiusMeters: simple instanced figures, one draw call for all of them;
 *  - beyond: simulated but not drawn.
 * Characters further than PedestrianDespawnRadiusMeters hand their walker back to the simulation.
 * Everyone within earshot of a gunshot (ReportGunshot) runs away from it.
 */
UCLASS()
class BUDAPESTSIM_API ANpcManager : public AActor
{
	GENERATED_BODY()

public:
	ANpcManager();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	/** The level's pedestrian manager, or null. */
	static ANpcManager* Get(const UObject* WorldContextObject);

	const FPedestrianGraph& GetGraph() const { return Graph; }

	/** Pedestrians currently shown as full characters. */
	int32 GetActiveCount() const { return Npcs.Num(); }

	/** Everyone simulated across the district, including those shown as characters. */
	int32 GetVirtualCount() const { return Crowd.GetAliveCount(); }

	/** Pedestrians currently drawn as distant figures. */
	int32 GetImpostorCount() const { return VisibleImpostors; }

	/** A shot was fired at Location: every pedestrian within AlarmRadiusCm runs away from it for about PanicSeconds. */
	void ReportGunshot(const FVector& Location, float AlarmRadiusCm);

	/** Closest street junction (that has at least one street) to Location, using a spatial grid. False if there is no street network. */
	bool FindNearestNode(const FVector& Location, int32& OutNode) const;

	/**
	 * Next street junction for a walker who came from `From` and is now at `Current`. Avoids turning
	 * back unless at a dead end, and favours busier streets. Returns INDEX_NONE if `Current` has no neighbours.
	 */
	int32 PickNextNode(int32 From, int32 Current, FRandomStream& Rng) const;

	/** Next junction for someone running away from ThreatLocation: a street that leads away from it. INDEX_NONE if none. */
	int32 PickFleeNode(int32 From, int32 Current, const FVector& ThreatLocation, FRandomStream& Rng) const;

	/** Fraction (0-1) of the peak population that is out at a local Budapest hour (0-24). A plausible daily rhythm, not measured data. */
	static float DensityForHour(float Hour);

	/** Called by a pedestrian that has just been killed: it leaves the crowd for good, and people nearby run. */
	void NotifyNpcDied(ANpcCharacter* Npc);

protected:
	/** Distant pedestrians: one instanced cylinder per person. */
	UPROPERTY(VisibleAnywhere, Category = "Pedestrians")
	TObjectPtr<UInstancedStaticMeshComponent> Impostors;

	/** Seconds between updates of the distant figures. */
	UPROPERTY(EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "0.02", ClampMax = "2.0"))
	float ImpostorUpdateInterval = 0.2f;

	/** Colour of the distant figures (dark clothing reads as people at a distance). */
	UPROPERTY(EditAnywhere, Category = "Pedestrians")
	FLinearColor ImpostorColor = FLinearColor(0.09f, 0.085f, 0.08f);

	/** How long a frightened pedestrian keeps running (+/-15%). */
	UPROPERTY(EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "1.0"))
	float PanicSeconds = 20.0f;

	/** People this close to someone who is killed run even if they heard no shot. */
	UPROPERTY(EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "0.0", Units = "cm"))
	float WitnessRadiusCm = 2500.0f;

	/** New characters per update at most, to spread the spawning cost over a few frames. */
	UPROPERTY(EditAnywhere, Category = "Pedestrians", meta = (ClampMin = "1"))
	int32 MaxSpawnsPerUpdate = 8;

private:
	void UpdatePopulationTarget();
	/** Hands walkers to characters and back around the camera. True if anyone changed level of detail. */
	bool UpdateCharacters(const FVector& View);
	void UpdateImpostors(const FVector& View);
	bool SpawnCharacter(int32 Agent);
	void HandBack(int32 NpcIndex);
	int32 FindFarthestNpc(const FVector& View, double& OutDistanceSq) const;
	bool FindViewLocation(FVector& OutLocation) const;

	FPedestrianGraph Graph;
	BudapestCrowd::FSim Crowd;
	FRandomStream Random;

	/** Characters on screen, and the crowd agent each one stands in for (same order). */
	UPROPERTY(Transient)
	TArray<TObjectPtr<ANpcCharacter>> Npcs;
	TArray<int32> NpcAgents;

	UPROPERTY(Transient)
	TArray<TSubclassOf<ANpcCharacter>> LookClasses;

	TWeakObjectPtr<ADayCycleActor> DayCycle;
	TArray<FTransform> ImpostorTransforms;
	int32 ImpostorPoolSize = 0;
	int32 VisibleImpostors = 0;
	double LastStepTime = -1.0;
	double LastImpostorTime = -1.0e9;
	bool bCrowdReady = false;
};
