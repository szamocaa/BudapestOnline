#include "Game/BudapestGameMode.h"

#include "City/DistrictBuildings.h"
#include "Engine/Engine.h"
#include "EngineUtils.h"
#include "Game/BudapestPawn.h"
#include "Npc/NpcManager.h"
#include "Transit/TransitManager.h"
#include "World/DayCycleActor.h"

namespace
{
	/** The existing actor of this type in the level, or a fresh one at the origin. */
	template <class ActorType>
	ActorType* FindOrSpawn(UWorld* World)
	{
		for (TActorIterator<ActorType> It(World); It; ++It)
		{
			return *It;
		}
		return World->SpawnActor<ActorType>();
	}
}

ABudapestGameMode::ABudapestGameMode()
{
	PrimaryActorTick.bCanEverTick = true;
	DefaultPawnClass = ABudapestPawn::StaticClass();
}

void ABudapestGameMode::BeginPlay()
{
	Super::BeginPlay();

	UWorld* World = GetWorld();
	if (World == nullptr)
	{
		return;
	}

	// Order matters: the sky first, then the city, then the things that live in it.
	DayCycle = FindOrSpawn<ADayCycleActor>(World);
	City = FindOrSpawn<ADistrictBuildings>(World);
	Transit = FindOrSpawn<ATransitManager>(World);
	Pedestrians = FindOrSpawn<ANpcManager>(World);
}

void ABudapestGameMode::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	ShowStatus();
}

void ABudapestGameMode::ShowStatus() const
{
	if (GEngine == nullptr)
	{
		return;
	}

	const FString Clock = DayCycle != nullptr ? DayCycle->GetClockString() : FString(TEXT("--:--"));
	const float Scale = DayCycle != nullptr ? DayCycle->GetTimeScale() : 1.0f;
	const float SunElevation = DayCycle != nullptr ? DayCycle->GetSunElevationDegrees() : 0.0f;

	GEngine->AddOnScreenDebugMessage(7401, 0.0f, FColor::White,
		FString::Printf(TEXT("Budapest VIII. district  |  %s  |  time x%g  |  sun %+.0f deg"), *Clock, Scale, SunElevation));

	const TCHAR* FeedMode = (Transit != nullptr && !Transit->IsUsingMockFeed()) ? TEXT("LIVE BKK data") : TEXT("SIMULATED (set BKK_API_KEY for live data)");
	GEngine->AddOnScreenDebugMessage(7402, 0.0f, FColor::Cyan,
		FString::Printf(TEXT("Transit: %s, %d vehicles  |  Pedestrians: %d  |  Buildings: %d"), FeedMode,
			Transit != nullptr ? Transit->GetVehicleCount() : 0, Pedestrians != nullptr ? Pedestrians->GetActiveCount() : 0,
			City != nullptr ? City->GetBuildingCount() : 0));

	GEngine->AddOnScreenDebugMessage(7403, 0.0f, FColor::Silver,
		TEXT("WASD + mouse fly, Q/E down/up, G street level, comma/period slower/faster clock, T real time"));
}
