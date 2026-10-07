#include "Transit/TransitVehicleActor.h"

#include "Components/StaticMeshComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"

ATransitVehicleActor::ATransitVehicleActor()
{
	PrimaryActorTick.bCanEverTick = true;

	Mesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));
	SetRootComponent(Mesh);
	Mesh->SetMobility(EComponentMobility::Movable);
	Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Mesh->SetCanEverAffectNavigation(false);

	static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeAsset(TEXT("/Engine/BasicShapes/Cube.Cube"));
	if (CubeAsset.Succeeded())
	{
		Mesh->SetStaticMesh(CubeAsset.Object);
	}
}

FLinearColor ATransitVehicleActor::ColorFor(const FTransitVehicleState& State)
{
	switch (State.Mode)
	{
	case ETransitMode::Tram: return FLinearColor(0.80f, 0.60f, 0.0f);
	case ETransitMode::Metro: return FLinearColor(0.70f, 0.02f, 0.02f);
	case ETransitMode::Bus: return FLinearColor(0.02f, 0.12f, 0.65f);
	case ETransitMode::Trolleybus: return FLinearColor(0.75f, 0.12f, 0.02f);
	case ETransitMode::SuburbanRail: return FLinearColor(0.02f, 0.45f, 0.08f);
	case ETransitMode::Ferry: return FLinearColor(0.0f, 0.5f, 0.6f);
	default: break;
	}
	// Mode not known yet: give each route its own stable colour so lines are still tellable apart.
	const uint32 Hash = GetTypeHash(State.RouteId);
	return FLinearColor::MakeFromHSV8(static_cast<uint8>(Hash % 256u), 200, 220);
}

FVector ATransitVehicleActor::DimensionsMeters(ETransitMode Mode)
{
	switch (Mode)
	{
	case ETransitMode::Tram: return FVector(30.0, 2.4, 3.4);
	case ETransitMode::Metro: return FVector(60.0, 2.8, 3.4);
	case ETransitMode::SuburbanRail: return FVector(50.0, 3.0, 4.0);
	case ETransitMode::Ferry: return FVector(35.0, 7.0, 6.0);
	default: return FVector(12.0, 2.5, 3.2); // bus, trolleybus, unknown
	}
}

void ATransitVehicleActor::InitializeFromState(const FTransitVehicleState& State, const FVector& WorldLocation, double NowSeconds, float InVisualScale)
{
	VisualScale = InVisualScale;
	CurrentState = State;
	LastSeenSeconds = NowSeconds;
	TargetLocation = WorldLocation;
	TargetRotation = FRotator(0.0, State.bHasBearing ? static_cast<double>(State.BearingDegrees) : 0.0, 0.0);

	// The cube is 1 m on a side, so its scale is its size in metres.
	SetActorScale3D(DimensionsMeters(State.Mode) * static_cast<double>(VisualScale));
	SetActorLocationAndRotation(WorldLocation, TargetRotation);

	if (UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")))
	{
		Material = UMaterialInstanceDynamic::Create(Base, this);
		Material->SetVectorParameterValue(TEXT("Color"), ColorFor(State));
		Mesh->SetMaterial(0, Material);
	}
}

void ATransitVehicleActor::UpdateFromState(const FTransitVehicleState& State, const FVector& WorldLocation, double NowSeconds)
{
	ApplyHeading(State, WorldLocation);
	CurrentState = State;
	LastSeenSeconds = NowSeconds;
	TargetLocation = WorldLocation;
}

void ATransitVehicleActor::ApplyHeading(const FTransitVehicleState& State, const FVector& NewLocation)
{
	if (State.bHasBearing)
	{
		// Compass bearing (clockwise from north) is exactly Unreal yaw in our frame (X = north, Y = east).
		TargetRotation = FRotator(0.0, static_cast<double>(State.BearingDegrees), 0.0);
		return;
	}

	// No bearing in the feed: face the direction of travel once the vehicle has moved noticeably.
	FVector Delta = NewLocation - TargetLocation;
	Delta.Z = 0.0;
	if (Delta.SizeSquared() > 100.0 * 100.0)
	{
		TargetRotation = FRotator(0.0, FMath::RadiansToDegrees(FMath::Atan2(Delta.Y, Delta.X)), 0.0);
	}
}

void ATransitVehicleActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	const FVector NewLocation = FMath::VInterpTo(GetActorLocation(), TargetLocation, DeltaSeconds, LocationInterpSpeed);
	const FRotator NewRotation = FMath::RInterpTo(GetActorRotation(), TargetRotation, DeltaSeconds, RotationInterpSpeed);
	SetActorLocationAndRotation(NewLocation, NewRotation);
}
