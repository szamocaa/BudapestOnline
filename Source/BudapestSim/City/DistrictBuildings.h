#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "DistrictBuildings.generated.h"

class UMaterialInterface;
class UProceduralMeshComponent;
class USceneComponent;
class UStaticMeshComponent;

/**
 * Builds the VIII. district from the baked OpenStreetMap footprints (Tools/Districts/bake_district.py):
 * every building is extruded to its height, courtyards included, and grouped into spatial chunks so
 * the GPU draws a few hundred meshes instead of thousands. Also provides a large flat ground.
 */
UCLASS()
class BUDAPESTSIM_API ADistrictBuildings : public AActor
{
	GENERATED_BODY()

public:
	ADistrictBuildings();

	virtual void BeginPlay() override;

	int32 GetBuildingCount() const { return BuildingCount; }

	/** Edge length of the square cells buildings are batched into. */
	UPROPERTY(EditAnywhere, Category = "City", meta = (ClampMin = "100.0", Units = "m"))
	float ChunkSizeMeters = 400.0f;

	UPROPERTY(EditAnywhere, Category = "City")
	bool bBuildGround = true;

	/** Half of the ground's side length. The district is about 3 km across. */
	UPROPERTY(EditAnywhere, Category = "City", meta = (Units = "km"))
	float GroundHalfSizeKm = 6.0f;

	/** Optional replacement for the built-in plain material; it should expose a vector parameter named ColorParameterName. */
	UPROPERTY(EditAnywhere, Category = "City")
	TObjectPtr<UMaterialInterface> SurfaceMaterial;

	UPROPERTY(EditAnywhere, Category = "City")
	FName ColorParameterName = TEXT("Color");

private:
	bool BuildBuildings();

	UPROPERTY(VisibleAnywhere, Category = "City")
	TObjectPtr<USceneComponent> Root;

	UPROPERTY(VisibleAnywhere, Category = "City")
	TObjectPtr<UStaticMeshComponent> Ground;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UProceduralMeshComponent>> Chunks;

	int32 BuildingCount = 0;
};
