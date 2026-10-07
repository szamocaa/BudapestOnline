#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Transit/TransitTypes.h"
#include "TransitManager.generated.h"

class ATransitVehicleActor;

/** Turns the feed's vehicle snapshots into moving actors in the world. */
UCLASS()
class BUDAPESTSIM_API ATransitManager : public AActor
{
	GENERATED_BODY()

public:
	ATransitManager();

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

	int32 GetVehicleCount() const { return Vehicles.Num(); }
	bool IsUsingMockFeed() const;

	UPROPERTY(EditAnywhere, Category = "Transit")
	TSubclassOf<ATransitVehicleActor> VehicleClass;

	/** Vehicles are drawn this many times larger than life so they can be seen from the air. */
	UPROPERTY(EditAnywhere, Category = "Transit", meta = (ClampMin = "0.1"))
	float VehicleVisualScale = 3.0f;

	/** Height of the vehicle's centre above the ground. */
	UPROPERTY(EditAnywhere, Category = "Transit", meta = (Units = "cm"))
	float VehicleHeightCm = 250.0f;

	/** A vehicle missing from the feed for this long is removed. */
	UPROPERTY(EditAnywhere, Category = "Transit", meta = (ClampMin = "5.0", Units = "s"))
	float StaleTimeoutSeconds = 45.0f;

	/** Only show vehicles inside (a margin around) the VIII. district. */
	UPROPERTY(EditAnywhere, Category = "Transit")
	bool bRestrictToDistrictVIII = true;

	UPROPERTY(EditAnywhere, Category = "Transit", meta = (ClampMin = "0.0"))
	double DistrictMarginDegrees = 0.002;

private:
	void HandleVehiclesUpdated(const TArray<FTransitVehicleState>& States);

	UPROPERTY(Transient)
	TMap<FString, TObjectPtr<ATransitVehicleActor>> Vehicles;

	FDelegateHandle UpdateHandle;
};
