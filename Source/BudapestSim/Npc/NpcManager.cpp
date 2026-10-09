#include "Npc/NpcManager.h"

#include "BudapestSim.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Game/BudapestGameMode.h"
#include "GameFramework/Pawn.h"
#include "HAL/PlatformTime.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Misc/Paths.h"
#include "Npc/NpcCharacter.h"
#include "Transit/BkkTransitSettings.h"
#include "World/BudapestWorldSettings.h"
#include "World/DayCycleActor.h"

#include <vector>

ANpcManager::ANpcManager()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickInterval = 0.1f; // crowd and level of detail ten times a second; characters tick themselves

	// Distant pedestrians: one instance each, no collision, no shadows (they are at least 150 m away).
	Impostors = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("Impostors"));
	Impostors->SetMobility(EComponentMobility::Movable);
	Impostors->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Impostors->SetGenerateOverlapEvents(false);
	Impostors->SetCanEverAffectNavigation(false);
	Impostors->SetCastShadow(false);
	SetRootComponent(Impostors);
}

ANpcManager* ANpcManager::Get(const UObject* WorldContextObject)
{
	UWorld* World = WorldContextObject != nullptr ? WorldContextObject->GetWorld() : nullptr;
	if (World == nullptr)
	{
		return nullptr;
	}
	if (const ABudapestGameMode* Mode = World->GetAuthGameMode<ABudapestGameMode>())
	{
		if (ANpcManager* Found = Mode->GetPedestrians())
		{
			return Found;
		}
	}
	TActorIterator<ANpcManager> It(World);
	return It ? *It : nullptr;
}

void ANpcManager::BeginPlay()
{
	Super::BeginPlay();

	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	const UBkkTransitSettings* Geo = GetDefault<UBkkTransitSettings>();
	const uint32 Seed = FPlatformTime::Cycles();
	Random.Initialize(static_cast<int32>(Seed & 0x7fffffffu));
	Crowd.Reset(static_cast<uint64>(Seed));

	if (!Settings->bSpawnPedestrians)
	{
		SetActorTickEnabled(false);
		return;
	}

	const FString Path = FPaths::Combine(FPaths::ProjectContentDir(), Settings->PathsFile);
	if (!Graph.LoadFromFile(Path, Geo->OriginLatitude, Geo->OriginLongitude))
	{
		SetActorTickEnabled(false);
		return;
	}

	// Hand the street network to the crowd simulation, each street once.
	std::vector<BudapestCrowd::FNode> SimNodes;
	SimNodes.reserve(static_cast<size_t>(Graph.Nodes.Num()));
	for (const FVector& Point : Graph.Nodes)
	{
		BudapestCrowd::FNode Node;
		Node.X = Point.X;
		Node.Y = Point.Y;
		SimNodes.push_back(Node);
	}
	std::vector<BudapestCrowd::FEdge> SimEdges;
	for (int32 From = 0; From < Graph.Adjacency.Num(); ++From)
	{
		for (const FPedestrianGraph::FEdge& Street : Graph.Adjacency[From])
		{
			if (From < Street.To)
			{
				BudapestCrowd::FEdge Edge;
				Edge.A = From;
				Edge.B = Street.To;
				Edge.Class = Street.Class;
				SimEdges.push_back(Edge);
			}
		}
	}
	Crowd.SetGraph(SimNodes, SimEdges);

	BudapestCrowd::FSimSettings SimSettings = Crowd.GetSettings();
	SimSettings.PanicSeconds = static_cast<double>(PanicSeconds);
	Crowd.SetSettings(SimSettings);

	for (const TSoftClassPtr<ANpcCharacter>& Soft : Settings->PedestrianClasses)
	{
		if (UClass* Loaded = Soft.LoadSynchronous())
		{
			LookClasses.Add(Loaded);
		}
		else if (!Soft.IsNull())
		{
			UE_LOG(LogBudapestSim, Warning, TEXT("Pedestrian class could not be loaded: %s"), *Soft.ToString());
		}
	}

	UStaticMesh* Cylinder = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	UMaterialInterface* BaseMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (Cylinder != nullptr)
	{
		Impostors->SetStaticMesh(Cylinder);
		if (BaseMaterial != nullptr)
		{
			UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(BaseMaterial, this);
			Material->SetVectorParameterValue(TEXT("Color"), ImpostorColor);
			Impostors->SetMaterial(0, Material);
		}
	}

	if (const ABudapestGameMode* Mode = GetWorld()->GetAuthGameMode<ABudapestGameMode>())
	{
		DayCycle = Mode->GetDayCycle();
	}
	if (!DayCycle.IsValid())
	{
		TActorIterator<ADayCycleActor> It(GetWorld());
		if (It)
		{
			DayCycle = *It;
		}
	}

	// Start with the streets as full as they should be right now, everywhere (the camera too).
	const float Hour = DayCycle.IsValid() ? DayCycle->GetLocalHours() : 12.0f;
	Crowd.SetTarget(FMath::RoundToInt(static_cast<float>(Settings->MaxDistrictPedestrians) * DensityForHour(Hour)), true);
	bCrowdReady = true;

	UE_LOG(LogBudapestSim, Log, TEXT("Pedestrians: %d out across the district now (peak %d), %d custom look(s)%s"),
		Crowd.GetAliveCount(), Settings->MaxDistrictPedestrians, LookClasses.Num(), LookClasses.IsEmpty() ? TEXT(" - using placeholder figures") : TEXT(""));
}

void ANpcManager::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	UWorld* World = GetWorld();
	if (!bCrowdReady || World == nullptr)
	{
		return;
	}

	// Step by the game time actually elapsed (robust whatever the tick interval does to DeltaSeconds).
	const double Now = World->GetTimeSeconds();
	const double Elapsed = LastStepTime < 0.0 ? static_cast<double>(DeltaSeconds) : Now - LastStepTime;
	LastStepTime = Now;

	UpdatePopulationTarget();

	FVector View = FVector::ZeroVector;
	const bool bHasView = FindViewLocation(View);
	if (bHasView)
	{
		// Nobody appears out of thin air, or vanishes, where the camera can see them as characters.
		const float QuietRadiusMeters = GetDefault<UBudapestWorldSettings>()->PedestrianDespawnRadiusMeters;
		Crowd.SetQuietZone(View.X, View.Y, static_cast<double>(QuietRadiusMeters) * 100.0);
	}
	else
	{
		Crowd.SetQuietZone(0.0, 0.0, 0.0);
	}
	Crowd.Step(Elapsed);

	if (!bHasView)
	{
		return;
	}
	const bool bLevelOfDetailChanged = UpdateCharacters(View);
	// Refresh the distant figures a few times a second, and at once when someone became (or stopped being)
	// a character, so nobody is drawn twice or disappears for a moment.
	if (bLevelOfDetailChanged || Now - LastImpostorTime >= static_cast<double>(ImpostorUpdateInterval))
	{
		UpdateImpostors(View);
		LastImpostorTime = Now;
	}
}

void ANpcManager::UpdatePopulationTarget()
{
	if (!DayCycle.IsValid())
	{
		if (const ABudapestGameMode* Mode = GetWorld()->GetAuthGameMode<ABudapestGameMode>())
		{
			DayCycle = Mode->GetDayCycle();
		}
	}
	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	const float Hour = DayCycle.IsValid() ? DayCycle->GetLocalHours() : 12.0f;
	Crowd.SetTarget(FMath::RoundToInt(static_cast<float>(Settings->MaxDistrictPedestrians) * DensityForHour(Hour)));
}

bool ANpcManager::UpdateCharacters(const FVector& View)
{
	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	const double DespawnRadius = static_cast<double>(FMath::Max(Settings->PedestrianDespawnRadiusMeters, 40.0f)) * 100.0;
	const double SpawnRadius = FMath::Min(static_cast<double>(Settings->PedestrianSpawnRadiusMeters) * 100.0, DespawnRadius - 1000.0);
	const int32 MaxCharacters = FMath::Max(Settings->MaxPedestrians, 0);
	bool bChanged = false;

	// Forget characters that vanished; hand back the ones the camera has left behind.
	for (int32 Index = Npcs.Num() - 1; Index >= 0; --Index)
	{
		ANpcCharacter* Npc = Npcs[Index];
		if (!IsValid(Npc) || Npc->IsDead())
		{
			// Destroyed by something else (fell out of the world, ...): that person has left the crowd too.
			Crowd.Kill(NpcAgents[Index]);
			Npcs.RemoveAtSwap(Index);
			NpcAgents.RemoveAtSwap(Index);
			bChanged = true;
		}
		else if ((Npc->GetActorLocation() - View).SizeSquared() > DespawnRadius * DespawnRadius)
		{
			HandBack(Index);
			bChanged = true;
		}
	}

	// Too many (MaxPedestrians lowered while running): the farthest go back to the simulation.
	while (Npcs.Num() > MaxCharacters)
	{
		double FarthestDistanceSq = 0.0;
		HandBack(FindFarthestNpc(View, FarthestDistanceSq));
		bChanged = true;
	}

	// Walkers within the character radius, closest first.
	struct FCandidate
	{
		double DistanceSq = 0.0;
		int32 Agent = INDEX_NONE;
	};
	TArray<FCandidate> Candidates;
	const double SpawnRadiusSq = SpawnRadius * SpawnRadius;
	const double HeightSq = FMath::Square(View.Z);
	for (int32 Agent = 0; Agent < Crowd.GetSlotCount(); ++Agent)
	{
		const BudapestCrowd::FAgent* Walker = Crowd.GetAgent(Agent);
		BudapestCrowd::FPose Pose;
		if (Walker == nullptr || Walker->bControlled || !Crowd.GetPose(Agent, Pose))
		{
			continue;
		}
		const double DistanceSq = FMath::Square(Pose.X - View.X) + FMath::Square(Pose.Y - View.Y) + HeightSq;
		if (DistanceSq <= SpawnRadiusSq)
		{
			FCandidate Candidate;
			Candidate.DistanceSq = DistanceSq;
			Candidate.Agent = Agent;
			Candidates.Add(Candidate);
		}
	}
	Candidates.Sort([](const FCandidate& Left, const FCandidate& Right) { return Left.DistanceSq < Right.DistanceSq; });

	int32 Spawned = 0;
	int32 Swaps = 0;
	for (const FCandidate& Candidate : Candidates)
	{
		if (Spawned >= MaxSpawnsPerUpdate)
		{
			break;
		}
		if (Npcs.Num() >= MaxCharacters)
		{
			// Full: trade the farthest character for this walker if it is clearly (20 m) closer, so the people
			// nearest the camera are always the detailed ones. A couple per update is plenty.
			double FarthestDistanceSq = 0.0;
			const int32 Farthest = FindFarthestNpc(View, FarthestDistanceSq);
			if (MaxCharacters == 0 || Swaps >= 2 || Farthest == INDEX_NONE ||
				FMath::Sqrt(Candidate.DistanceSq) + 2000.0 >= FMath::Sqrt(FarthestDistanceSq))
			{
				break;
			}
			HandBack(Farthest);
			++Swaps;
			bChanged = true;
		}
		if (SpawnCharacter(Candidate.Agent))
		{
			++Spawned;
			bChanged = true;
		}
	}
	return bChanged;
}

bool ANpcManager::SpawnCharacter(int32 Agent)
{
	const BudapestCrowd::FAgent* Found = Crowd.GetAgent(Agent);
	BudapestCrowd::FPose Pose;
	if (Found == nullptr || Found->bControlled || !Crowd.GetPose(Agent, Pose))
	{
		return false;
	}
	const BudapestCrowd::FAgent Walker = *Found;

	UClass* Look = ANpcCharacter::StaticClass();
	if (!LookClasses.IsEmpty())
	{
		// The look follows the person's seed, so whoever walks past again looks the same.
		UClass* Chosen = LookClasses[static_cast<int32>(Walker.Seed % static_cast<uint32>(LookClasses.Num()))].Get();
		Look = Chosen != nullptr ? Chosen : Look;
	}

	// Same place, direction, street, speed, pavement and look as the simulated walker.
	const double Yaw = FMath::RadiansToDegrees(FMath::Atan2(Pose.DirY, Pose.DirX));
	const FTransform SpawnTransform(FRotator(0.0, Yaw, 0.0), FVector(Pose.X, Pose.Y, 92.0));
	ANpcCharacter* Npc = GetWorld()->SpawnActorDeferred<ANpcCharacter>(Look, SpawnTransform, nullptr, nullptr, ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
	if (Npc == nullptr)
	{
		return false;
	}

	FNpcWalkState State;
	State.Agent = Agent;
	State.FromNode = Walker.From;
	State.ToNode = Walker.To;
	State.SpeedCmPerSec = static_cast<float>(Walker.Speed);
	State.Seed = static_cast<int32>(Walker.Seed);
	State.SideSign = static_cast<float>(Walker.Side);
	State.OffsetJitter = static_cast<float>(Walker.OffsetJitter);
	State.PanicSeconds = static_cast<float>(Walker.PanicSeconds);
	State.ThreatLocation = FVector(Walker.ThreatX, Walker.ThreatY, 0.0);
	Npc->InitNpc(this, State, FVector(Pose.X, Pose.Y, 0.0), Yaw);
	Npc->FinishSpawning(SpawnTransform);
	if (!IsValid(Npc))
	{
		return false;
	}

	Crowd.Detach(Agent);
	Npcs.Add(Npc);
	NpcAgents.Add(Agent);
	return true;
}

void ANpcManager::HandBack(int32 NpcIndex)
{
	if (!Npcs.IsValidIndex(NpcIndex))
	{
		return;
	}
	ANpcCharacter* Npc = Npcs[NpcIndex];
	const int32 Agent = NpcAgents[NpcIndex];

	// The walker carries on from where the character is: same street, pavement, and any panic.
	bool bAttached = false;
	FNpcWalkState State;
	if (IsValid(Npc) && Npc->GetWalkState(State))
	{
		const FVector Location = Npc->GetActorLocation();
		BudapestCrowd::FHandBack Back;
		Back.From = State.FromNode;
		Back.To = State.ToNode;
		if (Crowd.ProjectOntoEdge(Back.From, Back.To, Location.X, Location.Y, Back.Distance))
		{
			Back.Side = static_cast<double>(State.SideSign);
			Back.PanicSeconds = static_cast<double>(State.PanicSeconds);
			Back.ThreatX = State.ThreatLocation.X;
			Back.ThreatY = State.ThreatLocation.Y;
			bAttached = Crowd.Attach(Agent, Back);
		}
	}
	if (!bAttached)
	{
		Crowd.Kill(Agent); // lost track of the street: the population refills elsewhere
	}

	if (IsValid(Npc))
	{
		Npc->Destroy();
	}
	Npcs.RemoveAtSwap(NpcIndex);
	NpcAgents.RemoveAtSwap(NpcIndex);
}

int32 ANpcManager::FindFarthestNpc(const FVector& View, double& OutDistanceSq) const
{
	int32 Farthest = INDEX_NONE;
	OutDistanceSq = -1.0;
	for (int32 Index = 0; Index < Npcs.Num(); ++Index)
	{
		const ANpcCharacter* Npc = Npcs[Index];
		const double DistanceSq = IsValid(Npc) ? (Npc->GetActorLocation() - View).SizeSquared() : TNumericLimits<double>::Max();
		if (DistanceSq > OutDistanceSq)
		{
			OutDistanceSq = DistanceSq;
			Farthest = Index;
		}
	}
	return Farthest;
}

void ANpcManager::UpdateImpostors(const FVector& View)
{
	if (Impostors == nullptr || Impostors->GetStaticMesh() == nullptr)
	{
		return;
	}

	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	const double Radius = static_cast<double>(Settings->PedestrianImpostorRadiusMeters) * 100.0;
	const double RadiusSq = Radius * Radius;
	const double HeightSq = FMath::Square(View.Z);

	ImpostorTransforms.Reset();
	for (int32 Agent = 0; Agent < Crowd.GetSlotCount(); ++Agent)
	{
		const BudapestCrowd::FAgent* Walker = Crowd.GetAgent(Agent);
		BudapestCrowd::FPose Pose;
		if (Walker == nullptr || Walker->bControlled || !Crowd.GetPose(Agent, Pose))
		{
			continue;
		}
		if (FMath::Square(Pose.X - View.X) + FMath::Square(Pose.Y - View.Y) + HeightSq > RadiusSq)
		{
			continue;
		}
		// The engine cylinder is 1 m across and 1 m tall around its centre: scaled to a 45 cm wide,
		// 1.65-1.85 m tall figure standing on the ground.
		const double FigureHeight = 175.0 * (0.94 + 0.12 * static_cast<double>(Walker->Seed % 1000u) / 1000.0);
		const double Yaw = FMath::RadiansToDegrees(FMath::Atan2(Pose.DirY, Pose.DirX));
		ImpostorTransforms.Emplace(FRotator(0.0, Yaw, 0.0), FVector(Pose.X, Pose.Y, FigureHeight * 0.5), FVector(0.45, 0.45, FigureHeight / 100.0));
	}
	VisibleImpostors = ImpostorTransforms.Num();

	// The instance count only ever grows, in blocks; spare instances are parked, tiny, deep under the camera.
	const FTransform Parked(FRotator::ZeroRotator, FVector(View.X, View.Y, -100000.0), FVector(0.001));
	if (VisibleImpostors > ImpostorPoolSize)
	{
		const int32 NewPoolSize = (VisibleImpostors / 256 + 1) * 256;
		for (int32 Added = ImpostorPoolSize; Added < NewPoolSize; ++Added)
		{
			Impostors->AddInstance(Parked, true);
		}
		ImpostorPoolSize = NewPoolSize;
	}
	while (ImpostorTransforms.Num() < ImpostorPoolSize)
	{
		ImpostorTransforms.Add(Parked);
	}
	if (ImpostorPoolSize > 0)
	{
		Impostors->BatchUpdateInstancesTransforms(0, ImpostorTransforms, true, true, true);
	}
}

bool ANpcManager::FindViewLocation(FVector& OutLocation) const
{
	UWorld* World = GetWorld();
	if (World == nullptr)
	{
		return false;
	}
	if (const APlayerCameraManager* Camera = UGameplayStatics::GetPlayerCameraManager(World, 0))
	{
		OutLocation = Camera->GetCameraLocation();
		return true;
	}
	if (const APawn* Player = UGameplayStatics::GetPlayerPawn(World, 0))
	{
		OutLocation = Player->GetActorLocation();
		return true;
	}
	return false;
}

void ANpcManager::ReportGunshot(const FVector& Location, float AlarmRadiusCm)
{
	if (!bCrowdReady || !(AlarmRadiusCm > 0.0f))
	{
		return;
	}

	Crowd.Flee(Location.X, Location.Y, static_cast<double>(AlarmRadiusCm));

	const double RadiusSq = FMath::Square(static_cast<double>(AlarmRadiusCm));
	for (ANpcCharacter* Npc : Npcs)
	{
		if (IsValid(Npc) && (Npc->GetActorLocation() - Location).SizeSquared2D() <= RadiusSq)
		{
			Npc->Flee(Location, PanicSeconds * (0.85f + 0.3f * Random.FRand()));
		}
	}
}

void ANpcManager::NotifyNpcDied(ANpcCharacter* Npc)
{
	for (int32 Index = 0; Index < Npcs.Num(); ++Index)
	{
		if (Npcs[Index].Get() == Npc)
		{
			Crowd.Kill(NpcAgents[Index]);
			Npcs.RemoveAtSwap(Index);
			NpcAgents.RemoveAtSwap(Index);
			break;
		}
	}

	// Anyone who saw it happen runs, shot heard or not.
	if (Npc != nullptr && WitnessRadiusCm > 0.0f)
	{
		ReportGunshot(Npc->GetActorLocation(), WitnessRadiusCm);
	}
}

bool ANpcManager::FindNearestNode(const FVector& Location, int32& OutNode) const
{
	const int32 Node = Crowd.FindNearestNode(Location.X, Location.Y);
	if (Node < 0)
	{
		return false;
	}
	OutNode = Node;
	return true;
}

int32 ANpcManager::PickNextNode(int32 From, int32 Current, FRandomStream& Rng) const
{
	const int32 Next = Crowd.PickNextNode(From, Current, static_cast<double>(Rng.FRand()));
	return Next >= 0 ? Next : INDEX_NONE;
}

int32 ANpcManager::PickFleeNode(int32 From, int32 Current, const FVector& ThreatLocation, FRandomStream& Rng) const
{
	const int32 Next = Crowd.PickFleeNode(From, Current, ThreatLocation.X, ThreatLocation.Y, static_cast<double>(Rng.FRand()));
	return Next >= 0 ? Next : INDEX_NONE;
}

float ANpcManager::DensityForHour(float Hour)
{
	return BudapestCrowd::DensityForHour(Hour);
}
