#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "NpcCharacter.generated.h"

class ANpcManager;
class USceneComponent;

/**
 * How a pedestrian walks. Passed from the district crowd simulation to the character that stands in for
 * an agent near the camera, and back again when the character is too far away to be worth a full actor.
 */
struct FNpcWalkState
{
	/** Slot of the agent in the manager's crowd simulation. */
	int32 Agent = INDEX_NONE;
	int32 FromNode = INDEX_NONE;
	int32 ToNode = INDEX_NONE;
	float SpeedCmPerSec = 140.0f;
	/** Look seed: the same person (height, clothes, look class) every time this agent becomes a character. */
	int32 Seed = 1;
	/** +1 right-hand pavement relative to the walking direction, -1 left. */
	float SideSign = 1.0f;
	float OffsetJitter = 1.0f;
	/** Seconds of panic left (0 = calm), and what they are running from. */
	float PanicSeconds = 0.0f;
	FVector ThreatLocation = FVector::ZeroVector;
};

/**
 * A pedestrian that walks the district's streets. Make Blueprint children of this class and give each
 * a different skeletal mesh and animation blueprint (MetaHumans, Mixamo characters, ...) to get
 * realistic-looking people; list them under Project Settings > Game > Budapest World > Pedestrian Classes.
 * Without a mesh it draws a simple placeholder figure so the crowd logic can be seen working.
 *
 * Pedestrians can be shot (standard UE damage, e.g. UGameplayStatics::ApplyPointDamage): the capsule
 * blocks Visibility traces. They run from gunfire and collapse (ragdoll) when killed.
 */
UCLASS()
class BUDAPESTSIM_API ANpcCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	ANpcCharacter();

	/** Called by ANpcManager right after a deferred spawn, before BeginPlay. Feet go at StartLocation (Z = ground). */
	void InitNpc(ANpcManager* InManager, const FNpcWalkState& State, const FVector& StartLocation, double StartYawDegrees);

	/** Current walking state, for handing the pedestrian back to the crowd simulation. False if not walking (dead or not initialised). */
	bool GetWalkState(FNpcWalkState& OutState) const;

	int32 GetAgentIndex() const { return AgentIndex; }
	bool IsDead() const { return bDead; }
	float GetHealth() const { return Health; }
	bool IsPanicking() const { return PanicSeconds > 0.0f || ReactionDelay > 0.0f; }

	/**
	 * Run away from InThreatLocation for Seconds, through the street network. People react after a short,
	 * individual delay unless bImmediate. A new alarm while already running just updates the threat.
	 */
	void Flee(const FVector& InThreatLocation, float Seconds, bool bImmediate = false);

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;
	virtual float TakeDamage(float DamageAmount, struct FDamageEvent const& DamageEvent, AController* EventInstigator, AActor* DamageCauser) override;

protected:
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Pedestrian", meta = (ClampMin = "1.0"))
	float Health = 100.0f;

	/** Running speed when fleeing, for an average walker (cm/s); scaled by each person's own walking speed. */
	UPROPERTY(EditAnywhere, Category = "Pedestrian", meta = (ClampMin = "100.0"))
	float RunSpeedCmPerSec = 450.0f;

	/** Seconds a body stays in the street before it is removed. */
	UPROPERTY(EditAnywhere, Category = "Pedestrian", meta = (ClampMin = "1.0"))
	float CorpseLifeSeconds = 30.0f;

	/** Draw a crude figure from engine primitives when no skeletal mesh is assigned. */
	UPROPERTY(EditAnywhere, Category = "Pedestrian")
	bool bBuildPlaceholderIfNoMesh = true;

	/**
	 * Yaw applied to the skeletal mesh so it faces the walking direction. Epic's mannequins and most
	 * retargeted characters face +Y, hence -90. Change it if your characters walk sideways.
	 */
	UPROPERTY(EditAnywhere, Category = "Pedestrian")
	float MeshYawOffset = -90.0f;

	/** Random height variation, as a fraction (0.06 = +/-6%). */
	UPROPERTY(EditAnywhere, Category = "Pedestrian", meta = (ClampMin = "0.0", ClampMax = "0.3"))
	float HeightVariation = 0.06f;

private:
	bool ChooseNextWaypoint();
	void UpdateWaypoint();
	void UpdatePanic(float DeltaSeconds);
	void StartPanic(float Seconds);
	void Die(const FVector& ShotDirection);
	void BuildPlaceholder();

	TWeakObjectPtr<ANpcManager> Manager;
	FRandomStream Rng;
	int32 AgentIndex = INDEX_NONE;
	int32 LookSeed = 1;
	int32 FromNode = INDEX_NONE;
	int32 ToNode = INDEX_NONE;
	FVector Waypoint = FVector::ZeroVector;
	FVector ThreatLocation = FVector::ZeroVector;
	float SideSign = 1.0f;
	float OffsetJitter = 1.0f;
	float WalkSpeed = 140.0f;
	float PanicSeconds = 0.0f;
	float ReactionDelay = 0.0f;
	float PendingPanicSeconds = 0.0f;
	float GaitPhase = 0.0f;
	bool bInitialized = false;
	bool bIsPlaceholder = false;
	bool bDead = false;

	UPROPERTY(Transient)
	TObjectPtr<USceneComponent> PlaceholderRoot;
};
