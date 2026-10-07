#include "Npc/NpcCharacter.h"

#include "Components/CapsuleComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Npc/NpcManager.h"

ANpcCharacter::ANpcCharacter()
{
	PrimaryActorTick.bCanEverTick = true;
	AutoPossessAI = EAutoPossessAI::Disabled;
	bUseControllerRotationYaw = false;

	UCapsuleComponent* Capsule = GetCapsuleComponent();
	Capsule->InitCapsuleSize(30.0f, 90.0f);
	Capsule->SetCanEverAffectNavigation(false);
	// Pedestrians walk through each other and never block the camera.
	Capsule->SetCollisionResponseToChannel(ECC_Pawn, ECR_Ignore);
	Capsule->SetCollisionResponseToChannel(ECC_Camera, ECR_Ignore);

	UCharacterMovementComponent* Movement = GetCharacterMovement();
	Movement->bOrientRotationToMovement = true;
	Movement->RotationRate = FRotator(0.0, 360.0, 0.0);
	Movement->MaxWalkSpeed = 140.0f;
	Movement->bRunPhysicsWithNoController = true; // no AI controller per pedestrian: they are driven from Tick

	GetMesh()->SetRelativeLocation(FVector(0.0, 0.0, -90.0));
	GetMesh()->SetRelativeRotation(FRotator(0.0, MeshYawOffset, 0.0));
}

void ANpcCharacter::InitNpc(ANpcManager* InManager, int32 StartNode, int32 Seed)
{
	Manager = InManager;
	Rng.Initialize(Seed);
	SideSign = Rng.FRand() < 0.5f ? -1.0f : 1.0f;
	OffsetJitter = 0.8f + 0.4f * Rng.FRand();
	GetCharacterMovement()->MaxWalkSpeed = static_cast<float>(FMath::Lerp(WalkSpeedRangeCmPerSec.X, WalkSpeedRangeCmPerSec.Y, static_cast<double>(Rng.FRand())));
	SetActorScale3D(FVector(1.0 + static_cast<double>(HeightVariation) * static_cast<double>(Rng.FRand() * 2.0f - 1.0f)));

	FromNode = INDEX_NONE;
	ToNode = StartNode;
	bInitialized = true;
	ChooseNextWaypoint();

	// Start on the pavement beside the node rather than in the middle of the road.
	if (const ANpcManager* Mgr = Manager.Get())
	{
		if (Mgr->GetGraph().Nodes.IsValidIndex(FromNode))
		{
			FVector Start = Waypoint - Mgr->GetGraph().Nodes[ToNode] + Mgr->GetGraph().Nodes[FromNode];
			Start.Z = 100.0;
			SetActorLocation(Start, false, nullptr, ETeleportType::TeleportPhysics);
		}
	}
}

void ANpcCharacter::BeginPlay()
{
	Super::BeginPlay();

	GetMesh()->SetRelativeLocation(FVector(0.0, 0.0, -90.0));
	GetMesh()->SetRelativeRotation(FRotator(0.0, MeshYawOffset, 0.0));

	if (bBuildPlaceholderIfNoMesh && GetMesh()->GetSkeletalMeshAsset() == nullptr)
	{
		BuildPlaceholder();
	}
}

void ANpcCharacter::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (!bInitialized)
	{
		return;
	}
	if (GetActorLocation().Z < -5000.0)
	{
		Destroy(); // fell through the world (no ground collision)
		return;
	}

	FVector ToWaypoint = Waypoint - GetActorLocation();
	ToWaypoint.Z = 0.0;
	const double Distance = ToWaypoint.Size();
	if (Distance < 100.0)
	{
		ChooseNextWaypoint();
	}
	else
	{
		AddMovementInput(ToWaypoint / Distance, 1.0f);
	}

	if (bIsPlaceholder && PlaceholderRoot != nullptr)
	{
		// A little bob and sway in time with the stride so the figure reads as walking.
		GaitPhase += DeltaSeconds * GetVelocity().Size() * 0.045f;
		PlaceholderRoot->SetRelativeLocation(FVector(0.0, 0.0, 2.5 * FMath::Abs(FMath::Sin(static_cast<double>(GaitPhase)))));
		PlaceholderRoot->SetRelativeRotation(FRotator(0.0, 0.0, 2.0 * FMath::Sin(static_cast<double>(GaitPhase))));
	}
}

void ANpcCharacter::ChooseNextWaypoint()
{
	const ANpcManager* Mgr = Manager.Get();
	if (Mgr == nullptr || !Mgr->GetGraph().IsValid())
	{
		Destroy();
		return;
	}

	const int32 Next = Mgr->PickNextNode(FromNode, ToNode, Rng);
	if (Next == INDEX_NONE)
	{
		Destroy();
		return;
	}

	const FPedestrianGraph& Graph = Mgr->GetGraph();
	FromNode = ToNode;
	ToNode = Next;

	const FVector A = Graph.Nodes[FromNode];
	const FVector B = Graph.Nodes[ToNode];
	FVector Direction = B - A;
	Direction.Z = 0.0;
	Direction = Direction.GetSafeNormal();
	// Perpendicular in the horizontal plane (X = north, Y = east); which side we get depends on SideSign.
	const FVector Lateral(-Direction.Y, Direction.X, 0.0);

	// How far from the street centre line the pavement is, by street class: footpath, quiet street, main road.
	static const float OffsetsCm[] = { 60.0f, 480.0f, 750.0f };
	const uint8 EdgeClass = Graph.EdgeClass(FromNode, ToNode);
	const float Offset = OffsetsCm[FMath::Min<int32>(EdgeClass, 2)] * SideSign * OffsetJitter;

	Waypoint = B + Lateral * static_cast<double>(Offset);
}

void ANpcCharacter::BuildPlaceholder()
{
	UStaticMesh* Cylinder = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	UStaticMesh* Sphere = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	UMaterialInterface* BaseMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (Cylinder == nullptr || Sphere == nullptr)
	{
		return;
	}

	bIsPlaceholder = true;
	PlaceholderRoot = NewObject<USceneComponent>(this, TEXT("PlaceholderRoot"));
	PlaceholderRoot->SetupAttachment(GetCapsuleComponent());
	PlaceholderRoot->RegisterComponent();

	auto AddPart = [&](UStaticMesh* Mesh, const FVector& Location, const FVector& Scale, const FLinearColor& Color)
	{
		UStaticMeshComponent* Part = NewObject<UStaticMeshComponent>(this);
		Part->SetStaticMesh(Mesh);
		Part->SetupAttachment(PlaceholderRoot);
		Part->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Part->SetCanEverAffectNavigation(false);
		Part->SetCastShadow(false);
		Part->RegisterComponent();
		Part->SetRelativeLocation(Location);
		Part->SetRelativeScale3D(Scale);
		if (BaseMaterial != nullptr)
		{
			UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(BaseMaterial, this);
			Material->SetVectorParameterValue(TEXT("Color"), Color);
			Part->SetMaterial(0, Material);
		}
	};

	static const FLinearColor SkinTones[] =
	{
		FLinearColor(0.60f, 0.38f, 0.28f), FLinearColor(0.45f, 0.28f, 0.19f), FLinearColor(0.28f, 0.16f, 0.10f), FLinearColor(0.70f, 0.50f, 0.40f),
	};
	static const FLinearColor Trousers[] =
	{
		FLinearColor(0.02f, 0.03f, 0.07f), FLinearColor(0.03f, 0.03f, 0.03f), FLinearColor(0.12f, 0.10f, 0.07f), FLinearColor(0.07f, 0.09f, 0.12f),
	};
	const FLinearColor Skin = SkinTones[Rng.RandRange(0, UE_ARRAY_COUNT(SkinTones) - 1)];
	const FLinearColor Pants = Trousers[Rng.RandRange(0, UE_ARRAY_COUNT(Trousers) - 1)];
	const FLinearColor Shirt = FLinearColor::MakeFromHSV8(static_cast<uint8>(Rng.RandRange(0, 255)), static_cast<uint8>(Rng.RandRange(70, 190)), static_cast<uint8>(Rng.RandRange(110, 230)));

	// The capsule centre is 90 cm above the ground; figures are built in capsule space.
	AddPart(Cylinder, FVector(0.0, 0.0, -47.5), FVector(0.26, 0.26, 0.85), Pants); // legs
	AddPart(Cylinder, FVector(0.0, 0.0, 22.5), FVector(0.36, 0.26, 0.55), Shirt);   // torso
	AddPart(Sphere, FVector(0.0, 0.0, 61.0), FVector(0.22, 0.22, 0.24), Skin);      // head
}
