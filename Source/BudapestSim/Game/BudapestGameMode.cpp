#include "Game/BudapestGameMode.h"

#include "City/DistrictBuildings.h"
#include "City/StreetLamps.h"
#include "EngineUtils.h"
#include "Game/BudapestCharacter.h"
#include "Game/BudapestHUD.h"
#include "Game/BudapestPawn.h"
#include "Game/BudapestPlayerController.h"
#include "Npc/NpcManager.h"
#include "Transit/TransitManager.h"
#include "Transit/TransitNetwork.h"
#include "World/BudapestWorldSettings.h"
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
	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	DefaultPawnClass = Settings->bStartOnFoot ? ABudapestCharacter::StaticClass() : ABudapestPawn::StaticClass();
	PlayerControllerClass = ABudapestPlayerController::StaticClass();
	HUDClass = ABudapestHUD::StaticClass();
}

void ABudapestGameMode::BeginPlay()
{
	Super::BeginPlay();

	UWorld* World = GetWorld();
	if (World == nullptr)
	{
		return;
	}

	// Order matters: sky first, then the city and its networks, then the things that live in it.
	DayCycle = FindOrSpawn<ADayCycleActor>(World);
	City = FindOrSpawn<ADistrictBuildings>(World);
	TransitNetwork = FindOrSpawn<ATransitNetwork>(World);
	Transit = FindOrSpawn<ATransitManager>(World);
	Pedestrians = FindOrSpawn<ANpcManager>(World);
	StreetLamps = FindOrSpawn<AStreetLamps>(World);
}
