#include "Npc/NpcManager.h"

#include "BudapestSim.h"
#include "EngineUtils.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/Paths.h"
#include "Npc/NpcCharacter.h"
#include "Transit/BkkTransitSettings.h"
#include "World/BudapestWorldSettings.h"
#include "World/DayCycleActor.h"

ANpcManager::ANpcManager()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickInterval = 0.5f; // the crowd is topped up twice a second, individuals tick themselves
}

void ANpcManager::BeginPlay()
{
	Super::BeginPlay();

	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	const UBkkTransitSettings* Geo = GetDefault<UBkkTransitSettings>();
	Random.Initialize(FPlatformTime::Cycles());

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
	UE_LOG(LogBudapestSim, Log, TEXT("Pedestrians: %d custom look(s)%s"), LookClasses.Num(), LookClasses.IsEmpty() ? TEXT(" - using placeholder figures") : TEXT(""));

	for (TActorIterator<ADayCycleActor> It(GetWorld()); It; ++It)
	{
		DayCycle = *It;
		break;
	}
}

void ANpcManager::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	UpdatePopulation();
}

void ANpcManager::UpdatePopulation()
{
	UWorld* World = GetWorld();
	APawn* Player = World != nullptr ? UGameplayStatics::GetPlayerPawn(World, 0) : nullptr;
	if (Player == nullptr || !Graph.IsValid())
	{
		return;
	}

	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	const FVector Center = Player->GetActorLocation();
	const float DespawnRadius = Settings->PedestrianDespawnRadiusMeters * 100.0f;
	const float SpawnRadius = FMath::Min(Settings->PedestrianSpawnRadiusMeters * 100.0f, DespawnRadius - 500.0f);

	// Forget the dead and remove walkers the player has left behind.
	for (int32 Index = Npcs.Num() - 1; Index >= 0; --Index)
	{
		ANpcCharacter* Npc = Npcs[Index];
		if (!IsValid(Npc))
		{
			Npcs.RemoveAtSwap(Index);
		}
		else if (FVector::Dist2D(Npc->GetActorLocation(), Center) > DespawnRadius)
		{
			Npc->Destroy();
			Npcs.RemoveAtSwap(Index);
		}
	}

	const float Hour = DayCycle.IsValid() ? DayCycle->GetLocalHours() : 12.0f;
	const int32 Desired = FMath::RoundToInt(static_cast<float>(Settings->MaxPedestrians) * DensityForHour(Hour));

	// Grow or shrink gradually so the street never visibly pops.
	if (Npcs.Num() < Desired)
	{
		for (int32 Added = 0; Added < 6 && Npcs.Num() < Desired; ++Added)
		{
			if (!SpawnOne(Center, 800.0f, SpawnRadius))
			{
				break;
			}
		}
	}
	else if (Npcs.Num() > Desired)
	{
		for (int32 Removed = 0; Removed < 3 && Npcs.Num() > Desired; ++Removed)
		{
			int32 FarthestIndex = 0;
			double FarthestDistance = -1.0;
			for (int32 Index = 0; Index < Npcs.Num(); ++Index)
			{
				const double Distance = FVector::Dist2D(Npcs[Index]->GetActorLocation(), Center);
				if (Distance > FarthestDistance)
				{
					FarthestDistance = Distance;
					FarthestIndex = Index;
				}
			}
			Npcs[FarthestIndex]->Destroy();
			Npcs.RemoveAtSwap(FarthestIndex);
		}
	}
}

bool ANpcManager::SpawnOne(const FVector& Center, float MinDistance, float MaxDistance)
{
	for (int32 Attempt = 0; Attempt < 40; ++Attempt)
	{
		const int32 Node = Random.RandRange(0, Graph.Nodes.Num() - 1);
		const double Distance = FVector::Dist2D(Graph.Nodes[Node], Center);
		if (Distance < MinDistance || Distance > MaxDistance || Graph.Adjacency[Node].IsEmpty())
		{
			continue;
		}

		UClass* Look = ANpcCharacter::StaticClass();
		if (!LookClasses.IsEmpty())
		{
			Look = LookClasses[Random.RandRange(0, LookClasses.Num() - 1)].Get();
		}

		const FTransform SpawnTransform(FRotator::ZeroRotator, FVector(Graph.Nodes[Node].X, Graph.Nodes[Node].Y, 100.0));
		ANpcCharacter* Npc = GetWorld()->SpawnActorDeferred<ANpcCharacter>(Look, SpawnTransform, nullptr, nullptr, ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
		if (Npc == nullptr)
		{
			return false;
		}
		Npc->InitNpc(this, Node, NextSeed++);
		Npc->FinishSpawning(SpawnTransform);
		Npcs.Add(Npc);
		return true;
	}
	return false;
}

int32 ANpcManager::PickNextNode(int32 From, int32 Current, FRandomStream& Rng) const
{
	if (!Graph.Adjacency.IsValidIndex(Current) || Graph.Adjacency[Current].IsEmpty())
	{
		return INDEX_NONE;
	}

	// Busier streets draw more foot traffic than footpaths and back lanes.
	static const float ClassWeights[] = { 1.0f, 2.0f, 3.0f };
	const TArray<FPedestrianGraph::FEdge>& Edges = Graph.Adjacency[Current];

	float Total = 0.0f;
	for (const FPedestrianGraph::FEdge& Edge : Edges)
	{
		if (Edge.To != From)
		{
			Total += ClassWeights[FMath::Min<int32>(Edge.Class, 2)];
		}
	}
	if (Total <= 0.0f)
	{
		return From != INDEX_NONE ? From : Edges[0].To; // dead end: turn around
	}

	float Pick = Rng.FRand() * Total;
	for (const FPedestrianGraph::FEdge& Edge : Edges)
	{
		if (Edge.To == From)
		{
			continue;
		}
		Pick -= ClassWeights[FMath::Min<int32>(Edge.Class, 2)];
		if (Pick <= 0.0f)
		{
			return Edge.To;
		}
	}
	// Floating-point leftovers: take the last edge that is not the way we came.
	for (int32 Index = Edges.Num() - 1; Index >= 0; --Index)
	{
		if (Edges[Index].To != From)
		{
			return Edges[Index].To;
		}
	}
	return Edges[0].To;
}

float ANpcManager::DensityForHour(float Hour)
{
	// Fraction of the peak population out at each local hour: quiet nights, rush hours around 8 and 17, a lunch bump.
	static const float Hourly[24] =
	{
		0.04f, 0.03f, 0.02f, 0.02f, 0.03f, 0.07f, // 00-05
		0.18f, 0.50f, 0.90f, 0.70f, 0.60f, 0.65f, // 06-11
		0.85f, 0.80f, 0.65f, 0.65f, 0.80f, 1.00f, // 12-17
		0.95f, 0.80f, 0.60f, 0.45f, 0.30f, 0.15f, // 18-23
	};

	float Wrapped = FMath::Fmod(Hour, 24.0f);
	if (Wrapped < 0.0f)
	{
		Wrapped += 24.0f;
	}
	const int32 Index = FMath::Clamp(FMath::FloorToInt(Wrapped), 0, 23);
	return FMath::Lerp(Hourly[Index], Hourly[(Index + 1) % 24], Wrapped - static_cast<float>(Index));
}
