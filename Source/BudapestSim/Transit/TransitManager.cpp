#include "Transit/TransitManager.h"

#include "Engine/GameInstance.h"
#include "Transit/BkkTransitSettings.h"
#include "Transit/GeoProjection.h"
#include "Transit/TransitFeedSubsystem.h"
#include "Transit/TransitVehicleActor.h"

ATransitManager::ATransitManager()
{
	PrimaryActorTick.bCanEverTick = false;
	VehicleClass = ATransitVehicleActor::StaticClass();
}

bool ATransitManager::IsUsingMockFeed() const
{
	const UGameInstance* GameInstance = GetGameInstance();
	const UTransitFeedSubsystem* Feed = GameInstance != nullptr ? GameInstance->GetSubsystem<UTransitFeedSubsystem>() : nullptr;
	return Feed == nullptr || Feed->IsUsingMockFeed();
}

void ATransitManager::BeginPlay()
{
	Super::BeginPlay();

	if (UGameInstance* GameInstance = GetGameInstance())
	{
		if (UTransitFeedSubsystem* Feed = GameInstance->GetSubsystem<UTransitFeedSubsystem>())
		{
			UpdateHandle = Feed->OnVehiclesUpdated.AddUObject(this, &ATransitManager::HandleVehiclesUpdated);
			Feed->StartPolling();
		}
	}
}

void ATransitManager::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (UGameInstance* GameInstance = GetGameInstance())
	{
		if (UTransitFeedSubsystem* Feed = GameInstance->GetSubsystem<UTransitFeedSubsystem>())
		{
			Feed->OnVehiclesUpdated.Remove(UpdateHandle);
			Feed->StopPolling();
		}
	}
	Super::EndPlay(EndPlayReason);
}

void ATransitManager::HandleVehiclesUpdated(const TArray<FTransitVehicleState>& States)
{
	UWorld* World = GetWorld();
	if (World == nullptr)
	{
		return;
	}

	const UBkkTransitSettings* Geo = GetDefault<UBkkTransitSettings>();
	const double Now = World->GetTimeSeconds();

	for (const FTransitVehicleState& State : States)
	{
		if (bRestrictToDistrictVIII && !BudapestGeo::DistrictVIII::Contains(State.Latitude, State.Longitude, DistrictMarginDegrees))
		{
			continue;
		}

		const FVector Location = BudapestGeo::LatLonToWorld(State.Latitude, State.Longitude, Geo->OriginLatitude, Geo->OriginLongitude, static_cast<double>(VehicleHeightCm));

		if (TObjectPtr<ATransitVehicleActor>* Existing = Vehicles.Find(State.VehicleId))
		{
			if (IsValid(Existing->Get()))
			{
				(*Existing)->UpdateFromState(State, Location, Now);
				continue;
			}
		}

		UClass* ClassToSpawn = VehicleClass.Get();
		if (ClassToSpawn == nullptr)
		{
			ClassToSpawn = ATransitVehicleActor::StaticClass();
		}
		FActorSpawnParameters Params;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		Params.Owner = this;
		const FRotator Heading(0.0, State.bHasBearing ? static_cast<double>(State.BearingDegrees) : 0.0, 0.0);
		if (ATransitVehicleActor* Vehicle = World->SpawnActor<ATransitVehicleActor>(ClassToSpawn, Location, Heading, Params))
		{
			Vehicle->InitializeFromState(State, Location, Now, VehicleVisualScale);
			Vehicles.Add(State.VehicleId, Vehicle);
		}
	}

	// Drop vehicles that left the feed (or the district) a while ago.
	for (auto It = Vehicles.CreateIterator(); It; ++It)
	{
		ATransitVehicleActor* Vehicle = It.Value();
		if (!IsValid(Vehicle))
		{
			It.RemoveCurrent();
		}
		else if (Now - Vehicle->GetLastSeenSeconds() > static_cast<double>(StaleTimeoutSeconds))
		{
			Vehicle->Destroy();
			It.RemoveCurrent();
		}
	}
}
