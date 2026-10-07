#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "NpcCharacter.generated.h"

class ANpcManager;
class USceneComponent;

/**
 * A pedestrian that walks the district's streets. Make Blueprint children of this class and give each
 * a different skeletal mesh and animation blueprint (MetaHumans, Mixamo characters, ...) to get
 * realistic-looking people; list them under Project Settings > Game > Budapest World > Pedestrian Classes.
 * Without a mesh it draws a simple placeholder figure so the crowd logic can be seen working.
 */
UCLASS()
class BUDAPESTSIM_API ANpcCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	ANpcCharacter();

	/** Called by ANpcManager right after a deferred spawn, before BeginPlay. */
	void InitNpc(ANpcManager* InManager, int32 StartNode, int32 Seed);

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

protected:
	/** Draw a crude figure from engine primitives when no skeletal mesh is assigned. */
	UPROPERTY(EditAnywhere, Category = "Pedestrian")
	bool bBuildPlaceholderIfNoMesh = true;

	/**
	 * Yaw applied to the skeletal mesh so it faces the walking direction. Epic's mannequins and most
	 * retargeted characters face +Y, hence -90. Change it if your characters walk sideways.
	 */
	UPROPERTY(EditAnywhere, Category = "Pedestrian")
	float MeshYawOffset = -90.0f;

	/** Walking speed is picked at random in this range (cm/s). Adults average about 140. */
	UPROPERTY(EditAnywhere, Category = "Pedestrian")
	FVector2D WalkSpeedRangeCmPerSec = FVector2D(115.0, 160.0);

	/** Random height variation, as a fraction (0.06 = +/-6%). */
	UPROPERTY(EditAnywhere, Category = "Pedestrian", meta = (ClampMin = "0.0", ClampMax = "0.3"))
	float HeightVariation = 0.06f;

private:
	void ChooseNextWaypoint();
	void BuildPlaceholder();

	TWeakObjectPtr<ANpcManager> Manager;
	FRandomStream Rng;
	int32 FromNode = INDEX_NONE;
	int32 ToNode = INDEX_NONE;
	FVector Waypoint = FVector::ZeroVector;
	float SideSign = 1.0f;
	float OffsetJitter = 1.0f;
	float GaitPhase = 0.0f;
	bool bInitialized = false;
	bool bIsPlaceholder = false;

	UPROPERTY(Transient)
	TObjectPtr<USceneComponent> PlaceholderRoot;
};
