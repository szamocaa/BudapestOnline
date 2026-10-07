#pragma once

#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Transit/TransitTypes.h"
#include "TransitFeedSubsystem.generated.h"

DECLARE_MULTICAST_DELEGATE_OneParam(FOnTransitVehiclesUpdated, const TArray<FTransitVehicleState>&);

/**
 * Polls the BKK GTFS-realtime VehiclePositions feed (or a built-in mock when no API key is
 * configured) and broadcasts each full snapshot of vehicles.
 */
UCLASS()
class BUDAPESTSIM_API UTransitFeedSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Deinitialize() override;

	/** Starts the poll timer and fetches immediately. Safe to call repeatedly. */
	void StartPolling();
	void StopPolling();

	/** True when StartPolling will use simulated vehicles instead of the BKK feed. */
	bool IsUsingMockFeed() const;

	FOnTransitVehiclesUpdated OnVehiclesUpdated;

private:
	void Poll();
	void RequestLiveFeed(const FString& ApiKey);
	void HandleLiveResponse(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully);
	void PublishMockFeed();

	FTimerHandle PollTimerHandle;
	FHttpRequestPtr InFlightRequest;
};
