#include "Transit/TransitFeedSubsystem.h"

#include "BudapestSim.h"
#include "Engine/GameInstance.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "TimerManager.h"
#include "Transit/BkkTransitSettings.h"
#include "Transit/GeoProjection.h"
#include "Transit/GtfsRtDecoder.h"

namespace
{
	FString FromUtf8(const std::string& Text)
	{
		return FString(UTF8_TO_TCHAR(Text.c_str()));
	}

	FString RedactKey(const FString& Text, const FString& ApiKey)
	{
		return ApiKey.IsEmpty() ? Text : Text.Replace(*ApiKey, TEXT("<key>"), ESearchCase::CaseSensitive);
	}
}

void UTransitFeedSubsystem::Deinitialize()
{
	StopPolling();
	Super::Deinitialize();
}

bool UTransitFeedSubsystem::IsUsingMockFeed() const
{
	const UBkkTransitSettings* Settings = GetDefault<UBkkTransitSettings>();
	return Settings->bForceMockFeed || Settings->ResolveApiKey().IsEmpty();
}

void UTransitFeedSubsystem::StartPolling()
{
	UGameInstance* GameInstance = GetGameInstance();
	if (GameInstance == nullptr)
	{
		return;
	}

	FTimerManager& Timers = GameInstance->GetTimerManager();
	if (Timers.IsTimerActive(PollTimerHandle))
	{
		return;
	}

	const UBkkTransitSettings* Settings = GetDefault<UBkkTransitSettings>();
	if (IsUsingMockFeed())
	{
		UE_LOG(LogBudapestSim, Warning, TEXT("Transit feed: showing SIMULATED vehicles (no BKK API key set, or mock forced). "
			"Set BKK_API_KEY or Project Settings > Game > Budapest Transit > Api Key for live data."));
	}
	else
	{
		UE_LOG(LogBudapestSim, Log, TEXT("Transit feed: polling %s every %.0fs"),
			*RedactKey(Settings->VehiclePositionsUrlTemplate, Settings->ResolveApiKey()), Settings->PollIntervalSeconds);
	}

	Timers.SetTimer(PollTimerHandle, this, &UTransitFeedSubsystem::Poll, FMath::Max(1.0f, Settings->PollIntervalSeconds), true, 0.0f);
}

void UTransitFeedSubsystem::StopPolling()
{
	if (UGameInstance* GameInstance = GetGameInstance())
	{
		GameInstance->GetTimerManager().ClearTimer(PollTimerHandle);
	}

	if (InFlightRequest.IsValid())
	{
		InFlightRequest->OnProcessRequestComplete().Unbind();
		InFlightRequest->CancelRequest();
		InFlightRequest.Reset();
	}
}

void UTransitFeedSubsystem::Poll()
{
	const UBkkTransitSettings* Settings = GetDefault<UBkkTransitSettings>();
	const FString ApiKey = Settings->ResolveApiKey();

	if (Settings->bForceMockFeed || ApiKey.IsEmpty())
	{
		PublishMockFeed();
	}
	else
	{
		RequestLiveFeed(ApiKey);
	}
}

void UTransitFeedSubsystem::RequestLiveFeed(const FString& ApiKey)
{
	if (InFlightRequest.IsValid())
	{
		return; // previous request still running; never stack requests on a slow connection
	}

	const UBkkTransitSettings* Settings = GetDefault<UBkkTransitSettings>();
	const FString Url = Settings->VehiclePositionsUrlTemplate.Replace(TEXT("{key}"), *FGenericPlatformHttp::UrlEncode(ApiKey));

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	if (!Settings->ApiKeyHeaderName.IsEmpty())
	{
		Request->SetHeader(Settings->ApiKeyHeaderName, ApiKey);
	}
	Request->OnProcessRequestComplete().BindUObject(this, &UTransitFeedSubsystem::HandleLiveResponse);

	InFlightRequest = Request;
	Request->ProcessRequest();
}

void UTransitFeedSubsystem::HandleLiveResponse(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully)
{
	InFlightRequest.Reset();

	if (!bConnectedSuccessfully || !Response.IsValid())
	{
		UE_LOG(LogBudapestSim, Warning, TEXT("Transit feed: request failed (no response)."));
		return;
	}

	if (Response->GetResponseCode() != 200)
	{
		UE_LOG(LogBudapestSim, Warning, TEXT("Transit feed: HTTP %d from BKK. 401/403 usually means a missing or invalid API key."),
			Response->GetResponseCode());
		return;
	}

	const TArray<uint8>& Body = Response->GetContent();
	GtfsRt::FFeed Feed;
	if (!GtfsRt::DecodeVehiclePositions(Body.GetData(), static_cast<size_t>(Body.Num()), Feed))
	{
		UE_LOG(LogBudapestSim, Warning, TEXT("Transit feed: could not decode %d bytes as GTFS-realtime protobuf. "
			"Check that VehiclePositionsUrlTemplate points at the .pb feed."), Body.Num());
		return;
	}

	TArray<FTransitVehicleState> States;
	States.Reserve(static_cast<int32>(Feed.Vehicles.size()));
	for (const GtfsRt::FVehicleRecord& Record : Feed.Vehicles)
	{
		FTransitVehicleState& State = States.AddDefaulted_GetRef();
		State.VehicleId = FromUtf8(Record.VehicleId.empty() ? Record.EntityId : Record.VehicleId);
		State.Label = FromUtf8(Record.VehicleLabel);
		State.RouteId = FromUtf8(Record.RouteId);
		State.TripId = FromUtf8(Record.TripId);
		State.Latitude = static_cast<double>(Record.Latitude);
		State.Longitude = static_cast<double>(Record.Longitude);
		State.bHasBearing = Record.bHasBearing;
		State.BearingDegrees = Record.BearingDegrees;
		State.SpeedMetersPerSecond = Record.SpeedMetersPerSecond;
		State.Timestamp = static_cast<int64>(Record.Timestamp);
		// Mode stays Unknown until static GTFS (routes.txt route_type) is imported - see README roadmap.
	}

	UE_LOG(LogBudapestSim, Verbose, TEXT("Transit feed: %d vehicles"), States.Num());
	OnVehiclesUpdated.Broadcast(States);
}

void UTransitFeedSubsystem::PublishMockFeed()
{
	const UBkkTransitSettings* Settings = GetDefault<UBkkTransitSettings>();
	const double TimeSeconds = FPlatformTime::Seconds();
	const int64 UnixNow = FDateTime::UtcNow().ToUnixTimestamp();

	constexpr int32 MockVehicleCount = 36;
	constexpr double MockSpeedMetersPerSecond = 9.0;
	const ETransitMode Modes[] = { ETransitMode::Tram, ETransitMode::Metro, ETransitMode::Bus };
	const TCHAR* ModeNames[] = { TEXT("TRAM"), TEXT("METRO"), TEXT("BUS") };

	TArray<FTransitVehicleState> States;
	States.Reserve(MockVehicleCount);
	for (int32 Index = 0; Index < MockVehicleCount; ++Index)
	{
		// Vehicles circle the origin on rings of different radii, half of them in each direction.
		const double RadiusMeters = 1200.0 + 450.0 * static_cast<double>(Index % 9);
		const double Direction = (Index % 2 == 0) ? 1.0 : -1.0;
		const double Angle = 0.7 * static_cast<double>(Index) + Direction * MockSpeedMetersPerSecond / RadiusMeters * TimeSeconds;

		const double NorthMeters = RadiusMeters * FMath::Sin(Angle);
		const double EastMeters = RadiusMeters * FMath::Cos(Angle);
		const double VelocityNorth = Direction * FMath::Cos(Angle);
		const double VelocityEast = -Direction * FMath::Sin(Angle);

		FTransitVehicleState& State = States.AddDefaulted_GetRef();
		const int32 ModeIndex = Index % 3;
		State.VehicleId = FString::Printf(TEXT("MOCK_%02d"), Index);
		State.Label = State.VehicleId;
		State.RouteId = FString::Printf(TEXT("MOCK_%s_%d"), ModeNames[ModeIndex], Index % 4);
		State.Mode = Modes[ModeIndex];
		BudapestGeo::OffsetLatLon(Settings->OriginLatitude, Settings->OriginLongitude, NorthMeters, EastMeters, State.Latitude, State.Longitude);
		State.bHasBearing = true;
		State.BearingDegrees = static_cast<float>(FMath::Fmod(FMath::RadiansToDegrees(FMath::Atan2(VelocityEast, VelocityNorth)) + 360.0, 360.0));
		State.SpeedMetersPerSecond = static_cast<float>(MockSpeedMetersPerSecond);
		State.Timestamp = UnixNow;
	}

	OnVehiclesUpdated.Broadcast(States);
}
