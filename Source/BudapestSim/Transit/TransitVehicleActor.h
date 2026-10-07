#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Transit/TransitTypes.h"
#include "TransitVehicleActor.generated.h"

class UMaterialInstanceDynamic;
class UStaticMeshComponent;

/** One tram, metro train or bus. Glides smoothly between the positions the feed reports. */
UCLASS()
class BUDAPESTSIM_API ATransitVehicleActor : public AActor
{
	GENERATED_BODY()

public:
	ATransitVehicleActor();

	virtual void Tick(float DeltaSeconds) override;

	void InitializeFromState(const FTransitVehicleState& State, const FVector& WorldLocation, double NowSeconds, float VisualScale);
	void UpdateFromState(const FTransitVehicleState& State, const FVector& WorldLocation, double NowSeconds);

	double GetLastSeenSeconds() const { return LastSeenSeconds; }
	const FTransitVehicleState& GetState() const { return CurrentState; }

protected:
	UPROPERTY(VisibleAnywhere, Category = "Transit")
	TObjectPtr<UStaticMeshComponent> Mesh;

	/** Higher = catches up with the reported position faster. */
	UPROPERTY(EditAnywhere, Category = "Transit")
	float LocationInterpSpeed = 0.6f;

	UPROPERTY(EditAnywhere, Category = "Transit")
	float RotationInterpSpeed = 2.0f;

private:
	static FLinearColor ColorFor(const FTransitVehicleState& State);
	static FVector DimensionsMeters(ETransitMode Mode);
	void ApplyHeading(const FTransitVehicleState& State, const FVector& NewLocation);

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> Material;

	FTransitVehicleState CurrentState;
	FVector TargetLocation = FVector::ZeroVector;
	FRotator TargetRotation = FRotator::ZeroRotator;
	double LastSeenSeconds = 0.0;
	float VisualScale = 1.0f;
};
