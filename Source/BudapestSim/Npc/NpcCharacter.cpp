#include "Npc/NpcCharacter.h"

#include "City/PedestrianGraph.h"
#include "Components/CapsuleComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DamageEvents.h"
#include "Engine/StaticMesh.h"
#include "Game/BudapestCollision.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/Controller.h"
#include "GameFramework/Pawn.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Npc/CrowdSim.h"
#include "Npc/NpcManager.h"

ANpcCharacter::ANpcCharacter()
{
	PrimaryActorTick.bCanEverTick = true;
	AutoPossessAI = EAutoPossessAI::Disabled;
	bUseControllerRotationYaw = false;

	UCapsuleComponent* Capsule = GetCapsuleComponent();
	Capsule->InitCapsuleSize(30.0f, 90.0f);
	Capsule->SetCanEverAffectNavigation(false);
	// Pedestrians walk through each other, never block the camera, and slip past walls their pavement
	// offset happens to clip. Weapon traces (Visibility) hit them.
	Capsule->SetCollisionResponseToChannel(ECC_Pawn, ECR_Ignore);
	Capsule->SetCollisionResponseToChannel(ECC_Camera, ECR_Ignore);
	Capsule->SetCollisionResponseToChannel(BudapestCollision::Building, ECR_Ignore);
	Capsule->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);

	UCharacterMovementComponent* Movement = GetCharacterMovement();
	Movement->bOrientRotationToMovement = true;
	Movement->RotationRate = FRotator(0.0, 540.0, 0.0);
	Movement->MaxWalkSpeed = 140.0f;
	Movement->bRunPhysicsWithNoController = true; // no AI controller per pedestrian: they are driven from Tick

	GetMesh()->SetRelativeLocation(FVector(0.0, 0.0, -90.0));
	GetMesh()->SetRelativeRotation(FRotator(0.0, MeshYawOffset, 0.0));
}

void ANpcCharacter::InitNpc(ANpcManager* InManager, const FNpcWalkState& State, const FVector& StartLocation, double StartYawDegrees)
{
	Manager = InManager;
	AgentIndex = State.Agent;
	LookSeed = State.Seed;
	Rng.Initialize(State.Seed);
	SideSign = State.SideSign < 0.0f ? -1.0f : 1.0f;
	OffsetJitter = State.OffsetJitter;
	WalkSpeed = FMath::Max(State.SpeedCmPerSec, 30.0f);
	FromNode = State.FromNode;
	ToNode = State.ToNode;
	GetCharacterMovement()->MaxWalkSpeed = WalkSpeed;

	// The look seed decides height (here) and clothes (BuildPlaceholder), so the same agent is always the same person.
	SetActorScale3D(FVector(1.0 + static_cast<double>(HeightVariation) * static_cast<double>(Rng.FRand() * 2.0f - 1.0f)));
	const double HalfHeight = static_cast<double>(GetCapsuleComponent()->GetScaledCapsuleHalfHeight());
	SetActorLocationAndRotation(FVector(StartLocation.X, StartLocation.Y, StartLocation.Z + HalfHeight + 2.0),
		FRotator(0.0, StartYawDegrees, 0.0), false, nullptr, ETeleportType::TeleportPhysics);

	bInitialized = true;
	UpdateWaypoint();

	if (State.PanicSeconds > 0.0f)
	{
		ThreatLocation = State.ThreatLocation;
		StartPanic(State.PanicSeconds); // already running when the camera got close: no second startle
	}
}

bool ANpcCharacter::GetWalkState(FNpcWalkState& OutState) const
{
	if (!bInitialized || bDead)
	{
		return false;
	}
	OutState.Agent = AgentIndex;
	OutState.FromNode = FromNode;
	OutState.ToNode = ToNode;
	OutState.SpeedCmPerSec = WalkSpeed;
	OutState.Seed = LookSeed;
	OutState.SideSign = SideSign;
	OutState.OffsetJitter = OffsetJitter;
	OutState.PanicSeconds = ReactionDelay > 0.0f ? PendingPanicSeconds : PanicSeconds;
	OutState.ThreatLocation = ThreatLocation;
	return true;
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

	if (!bInitialized || bDead)
	{
		return;
	}
	if (GetActorLocation().Z < -5000.0)
	{
		Destroy(); // fell through the world (no ground collision)
		return;
	}

	UpdatePanic(DeltaSeconds);

	FVector ToWaypoint = Waypoint - GetActorLocation();
	ToWaypoint.Z = 0.0;
	const double Distance = ToWaypoint.Size();
	// A runner turns wider, so it accepts its waypoint from a little further away.
	const double ReachCm = PanicSeconds > 0.0f ? 160.0 : 100.0;
	if (Distance < ReachCm)
	{
		if (!ChooseNextWaypoint())
		{
			Destroy();
			return;
		}
	}
	else
	{
		AddMovementInput(ToWaypoint / Distance, 1.0f);
	}

	if (bIsPlaceholder && PlaceholderRoot != nullptr)
	{
		// A little bob and sway in time with the stride so the figure reads as walking (or running).
		GaitPhase += DeltaSeconds * static_cast<float>(GetVelocity().Size()) * 0.045f;
		PlaceholderRoot->SetRelativeLocation(FVector(0.0, 0.0, 2.5 * FMath::Abs(FMath::Sin(static_cast<double>(GaitPhase)))));
		PlaceholderRoot->SetRelativeRotation(FRotator(0.0, 0.0, 2.0 * FMath::Sin(static_cast<double>(GaitPhase))));
	}
}

void ANpcCharacter::Flee(const FVector& InThreatLocation, float Seconds, bool bImmediate)
{
	if (!bInitialized || bDead || !(Seconds > 0.0f))
	{
		return;
	}

	ThreatLocation = InThreatLocation;
	if (bImmediate || PanicSeconds > 0.0f)
	{
		StartPanic(FMath::Max(Seconds, PanicSeconds));
		return;
	}

	PendingPanicSeconds = FMath::Max(Seconds, PendingPanicSeconds);
	if (ReactionDelay <= 0.0f)
	{
		// Startle, look round, then run: a fraction of a second, different for everyone.
		ReactionDelay = 0.2f + 0.6f * Rng.FRand();
	}
}

void ANpcCharacter::UpdatePanic(float DeltaSeconds)
{
	if (ReactionDelay > 0.0f)
	{
		ReactionDelay -= DeltaSeconds;
		if (ReactionDelay <= 0.0f)
		{
			ReactionDelay = 0.0f;
			StartPanic(PendingPanicSeconds);
		}
		return;
	}

	if (PanicSeconds > 0.0f)
	{
		PanicSeconds -= DeltaSeconds;
		if (PanicSeconds <= 0.0f)
		{
			PanicSeconds = 0.0f;
			GetCharacterMovement()->MaxWalkSpeed = WalkSpeed; // calmed down: back to a walk
		}
	}
}

void ANpcCharacter::StartPanic(float Seconds)
{
	PanicSeconds = FMath::Max(Seconds, 0.1f);
	ReactionDelay = 0.0f;
	PendingPanicSeconds = 0.0f;
	GetCharacterMovement()->MaxWalkSpeed = RunSpeedCmPerSec * WalkSpeed / 140.0f;

	// Heading towards the danger? Turn round on the spot, keeping to the same pavement.
	const FVector Here = GetActorLocation();
	const FVector Ahead = Waypoint - Here;
	const FVector ToThreat = ThreatLocation - Here;
	if (FromNode != INDEX_NONE && ToNode != INDEX_NONE && Ahead.X * ToThreat.X + Ahead.Y * ToThreat.Y > 0.0)
	{
		Swap(FromNode, ToNode);
		SideSign = -SideSign;
		UpdateWaypoint();
	}
}

float ANpcCharacter::TakeDamage(float DamageAmount, struct FDamageEvent const& DamageEvent, AController* EventInstigator, AActor* DamageCauser)
{
	if (bDead)
	{
		return 0.0f;
	}

	const float Applied = Super::TakeDamage(DamageAmount, DamageEvent, EventInstigator, DamageCauser);
	if (Applied <= 0.0f)
	{
		return Applied;
	}

	FVector ShotDirection = FVector::ZeroVector;
	if (DamageEvent.IsOfType(FPointDamageEvent::ClassID))
	{
		ShotDirection = static_cast<const FPointDamageEvent&>(DamageEvent).ShotDirection;
	}

	Health -= Applied;
	if (Health <= 0.0f)
	{
		Health = 0.0f;
		Die(ShotDirection);
		return Applied;
	}

	// Wounded: run from whoever did it, at once.
	FVector Source = GetActorLocation() - ShotDirection * 1000.0;
	if (EventInstigator != nullptr && EventInstigator->GetPawn() != nullptr)
	{
		Source = EventInstigator->GetPawn()->GetActorLocation();
	}
	else if (DamageCauser != nullptr)
	{
		Source = DamageCauser->GetActorLocation();
	}
	Flee(Source, 25.0f, true);
	return Applied;
}

void ANpcCharacter::Die(const FVector& ShotDirection)
{
	bDead = true;
	PanicSeconds = 0.0f;
	ReactionDelay = 0.0f;

	UCharacterMovementComponent* Movement = GetCharacterMovement();
	Movement->StopMovementImmediately();
	Movement->DisableMovement();
	Movement->SetComponentTickEnabled(false);
	GetCapsuleComponent()->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	USkeletalMeshComponent* Body = GetMesh();
	if (Body != nullptr && Body->GetSkeletalMeshAsset() != nullptr)
	{
		// Collapse: the mesh's physics asset takes over (Epic's mannequins and MetaHuman bodies come with one).
		Body->SetCollisionProfileName(TEXT("Ragdoll"));
		Body->SetSimulatePhysics(true);
		Body->WakeAllRigidBodies();
		if (!ShotDirection.IsNearlyZero())
		{
			Body->AddImpulse(ShotDirection.GetSafeNormal() * 150.0, NAME_None, true);
		}
	}
	else if (PlaceholderRoot != nullptr)
	{
		// Placeholder figure: fall flat, away from the shot (or forwards). Pitch -90 lays the figure's head along +X.
		const FVector FallDirection = ShotDirection.IsNearlyZero() ? GetActorForwardVector() : ShotDirection;
		SetActorRotation(FRotator(0.0, FallDirection.Rotation().Yaw, 0.0));
		PlaceholderRoot->SetRelativeLocationAndRotation(FVector(15.0, 0.0, -72.0), FRotator(-90.0, 0.0, 0.0));
	}

	SetActorTickEnabled(false);
	SetLifeSpan(CorpseLifeSeconds);

	// The manager removes the agent from the crowd so this person is never handed back to the simulation.
	if (ANpcManager* Mgr = Manager.Get())
	{
		Mgr->NotifyNpcDied(this);
	}
}

bool ANpcCharacter::ChooseNextWaypoint()
{
	const ANpcManager* Mgr = Manager.Get();
	if (Mgr == nullptr || !Mgr->GetGraph().IsValid())
	{
		return false;
	}

	const int32 Next = PanicSeconds > 0.0f ? Mgr->PickFleeNode(FromNode, ToNode, ThreatLocation, Rng) : Mgr->PickNextNode(FromNode, ToNode, Rng);
	if (Next == INDEX_NONE)
	{
		return false;
	}

	if (Next == FromNode)
	{
		SideSign = -SideSign; // turning back: stay on the same pavement (as the crowd simulation does)
	}
	FromNode = ToNode;
	ToNode = Next;
	UpdateWaypoint();
	return true;
}

void ANpcCharacter::UpdateWaypoint()
{
	const ANpcManager* Mgr = Manager.Get();
	if (Mgr == nullptr)
	{
		return;
	}
	const FPedestrianGraph& Graph = Mgr->GetGraph();
	if (!Graph.Nodes.IsValidIndex(FromNode) || !Graph.Nodes.IsValidIndex(ToNode))
	{
		return;
	}

	const FVector A = Graph.Nodes[FromNode];
	const FVector B = Graph.Nodes[ToNode];
	FVector Direction = B - A;
	Direction.Z = 0.0;
	Direction = Direction.GetSafeNormal();
	// Perpendicular in the horizontal plane (X = north, Y = east); which side we get depends on SideSign.
	const FVector Lateral(-Direction.Y, Direction.X, 0.0);

	// How far from the street centre line the pavement is, by street class (same table as the crowd simulation).
	const double Offset = BudapestCrowd::PavementOffsetCm(Graph.EdgeClass(FromNode, ToNode)) * static_cast<double>(SideSign * OffsetJitter);
	Waypoint = B + Lateral * Offset;
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

	auto AddPart = [&](UStaticMesh* Shape, const FVector& Location, const FVector& Scale, const FLinearColor& Color)
	{
		UStaticMeshComponent* Part = NewObject<UStaticMeshComponent>(this);
		Part->SetStaticMesh(Shape);
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
	const FLinearColor Skin = SkinTones[Rng.RandRange(0, static_cast<int32>(UE_ARRAY_COUNT(SkinTones)) - 1)];
	const FLinearColor Pants = Trousers[Rng.RandRange(0, static_cast<int32>(UE_ARRAY_COUNT(Trousers)) - 1)];
	const FLinearColor Shirt = FLinearColor::MakeFromHSV8(static_cast<uint8>(Rng.RandRange(0, 255)), static_cast<uint8>(Rng.RandRange(70, 190)), static_cast<uint8>(Rng.RandRange(110, 230)));

	// The capsule centre is 90 cm above the ground; figures are built in capsule space.
	AddPart(Cylinder, FVector(0.0, 0.0, -47.5), FVector(0.26, 0.26, 0.85), Pants); // legs
	AddPart(Cylinder, FVector(0.0, 0.0, 22.5), FVector(0.36, 0.26, 0.55), Shirt);   // torso
	AddPart(Sphere, FVector(0.0, 0.0, 61.0), FVector(0.22, 0.22, 0.24), Skin);      // head
}
