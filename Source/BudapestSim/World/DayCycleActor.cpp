#include "World/DayCycleActor.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/PostProcessComponent.h"
#include "Components/SceneComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Misc/DateTime.h"
#include "Transit/BkkTransitSettings.h"
#include "World/Astro.h"
#include "World/BudapestWorldSettings.h"

namespace
{
	/** Unit vector toward a sky position in the world frame (X = north, Y = east, Z = up). */
	FVector DirectionToSky(double AzimuthDegrees, double ElevationDegrees)
	{
		const double Azimuth = FMath::DegreesToRadians(AzimuthDegrees);
		const double Elevation = FMath::DegreesToRadians(ElevationDegrees);
		return FVector(FMath::Cos(Elevation) * FMath::Cos(Azimuth), FMath::Cos(Elevation) * FMath::Sin(Azimuth), FMath::Sin(Elevation));
	}

	double UnixNow()
	{
		return (FDateTime::UtcNow() - FDateTime(1970, 1, 1)).GetTotalSeconds();
	}
}

ADayCycleActor::ADayCycleActor()
{
	PrimaryActorTick.bCanEverTick = true;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	SetRootComponent(Root);

	Sun = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Sun"));
	Sun->SetupAttachment(Root);
	Sun->SetMobility(EComponentMobility::Movable);
	Sun->SetIntensity(SunIntensity);
	Sun->SetAtmosphereSunLightIndex(0);

	// The moon is a second atmosphere light so the sky and clouds react to it at night.
	Moon = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Moon"));
	Moon->SetupAttachment(Root);
	Moon->SetMobility(EComponentMobility::Movable);
	Moon->SetIntensity(0.0f);
	Moon->SetLightColor(FLinearColor(0.72f, 0.82f, 1.0f));
	Moon->SetAtmosphereSunLightIndex(1);

	Atmosphere = CreateDefaultSubobject<USkyAtmosphereComponent>(TEXT("Atmosphere"));
	Atmosphere->SetupAttachment(Root);

	SkyLight = CreateDefaultSubobject<USkyLightComponent>(TEXT("SkyLight"));
	SkyLight->SetupAttachment(Root);
	SkyLight->SetMobility(EComponentMobility::Movable);
	SkyLight->bRealTimeCapture = true; // re-captures the sky every frame, so ambient light follows the time of day

	Fog = CreateDefaultSubobject<UExponentialHeightFogComponent>(TEXT("Fog"));
	Fog->SetupAttachment(Root);

	Exposure = CreateDefaultSubobject<UPostProcessComponent>(TEXT("Exposure"));
	Exposure->SetupAttachment(Root);
	Exposure->bUnbound = true;
	Exposure->Settings.bOverride_AutoExposureBias = true;
	Exposure->Settings.AutoExposureBias = 0.0f;
}

void ADayCycleActor::BeginPlay()
{
	Super::BeginPlay();

	const UBudapestWorldSettings* Settings = GetDefault<UBudapestWorldSettings>();
	TimeScale = Settings->TimeScale;
	SyncToRealTime();
	if (!Settings->bStartAtRealBudapestTime)
	{
		SetLocalHour(Settings->StartLocalHour);
	}
	ApplySky();
}

void ADayCycleActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	SimUnixSeconds += static_cast<double>(DeltaSeconds) * static_cast<double>(TimeScale);

	// At real-time speed the sun moves 0.004 degrees per second, so refreshing twice a second is plenty.
	SecondsSinceSkyUpdate += DeltaSeconds;
	if (TimeScale > 2.0f || SecondsSinceSkyUpdate >= 0.5f)
	{
		SecondsSinceSkyUpdate = 0.0f;
		ApplySky();
	}
}

float ADayCycleActor::GetLocalHours() const
{
	return static_cast<float>(Astro::BudapestLocalHours(SimUnixSeconds));
}

FString ADayCycleActor::GetClockString() const
{
	static const TCHAR* const MonthNames[] = { TEXT("Jan"), TEXT("Feb"), TEXT("Mar"), TEXT("Apr"), TEXT("May"), TEXT("Jun"),
		TEXT("Jul"), TEXT("Aug"), TEXT("Sep"), TEXT("Oct"), TEXT("Nov"), TEXT("Dec") };

	const int64 Whole = static_cast<int64>(FMath::FloorToDouble(SimUnixSeconds));
	const int32 OffsetHours = Astro::BudapestUtcOffsetHours(Whole);
	const FDateTime Local = FDateTime::FromUnixTimestamp(Whole + static_cast<int64>(OffsetHours) * 3600);
	return FString::Printf(TEXT("%02d:%02d %s, %02d %s %d"), Local.GetHour(), Local.GetMinute(),
		OffsetHours == 2 ? TEXT("CEST") : TEXT("CET"), Local.GetDay(), MonthNames[FMath::Clamp(Local.GetMonth(), 1, 12) - 1], Local.GetYear());
}

void ADayCycleActor::SetTimeScale(float NewTimeScale)
{
	TimeScale = FMath::Clamp(NewTimeScale, 0.0f, 7200.0f);
}

void ADayCycleActor::SetLocalHour(float Hour)
{
	const int64 Whole = static_cast<int64>(FMath::FloorToDouble(SimUnixSeconds));
	const double OffsetSeconds = 3600.0 * Astro::BudapestUtcOffsetHours(Whole);
	const double LocalSeconds = SimUnixSeconds + OffsetSeconds;
	const double DayStart = FMath::FloorToDouble(LocalSeconds / 86400.0) * 86400.0;
	SimUnixSeconds = DayStart + static_cast<double>(FMath::Clamp(Hour, 0.0f, 23.99f)) * 3600.0 - OffsetSeconds;
	SecondsSinceSkyUpdate = 1000.0f;
}

void ADayCycleActor::SyncToRealTime()
{
	SimUnixSeconds = UnixNow();
	SecondsSinceSkyUpdate = 1000.0f;
}

void ADayCycleActor::ApplySky()
{
	const UBkkTransitSettings* Geo = GetDefault<UBkkTransitSettings>();
	const Astro::FSkyBody SunPosition = Astro::SunPosition(SimUnixSeconds, Geo->OriginLatitude, Geo->OriginLongitude);
	const Astro::FMoon MoonPosition = Astro::MoonPosition(SimUnixSeconds, Geo->OriginLatitude, Geo->OriginLongitude);

	const float SunElevation = static_cast<float>(SunPosition.ElevationDegrees);
	const float MoonElevation = static_cast<float>(MoonPosition.ElevationDegrees);
	SunElevationDegrees = SunElevation;

	// A light shines along its forward axis, i.e. away from the body it represents.
	Sun->SetWorldRotation((-DirectionToSky(SunPosition.AzimuthDegrees, SunPosition.ElevationDegrees)).Rotation());
	Moon->SetWorldRotation((-DirectionToSky(MoonPosition.AzimuthDegrees, MoonPosition.ElevationDegrees)).Rotation());

	// Direct sunlight fades through twilight (civil -> astronomical); the atmosphere itself handles the sunset colours.
	Sun->SetIntensity(SunIntensity * FMath::SmoothStep(-18.0f, -6.0f, SunElevation));

	// Moonlight needs the moon up, some phase, and a sky that is no longer bright with sun.
	const float MoonUp = FMath::SmoothStep(-2.0f, 6.0f, MoonElevation);
	const float Darkness = 1.0f - FMath::SmoothStep(-10.0f, -2.0f, SunElevation);
	Moon->SetIntensity(MoonMaxIntensity * static_cast<float>(MoonPosition.IlluminatedFraction) * MoonUp * Darkness);

	// Eyes adapt: lift exposure at night so the city does not go pitch black.
	const float Daylight = FMath::SmoothStep(-12.0f, 0.0f, SunElevation);
	Exposure->Settings.AutoExposureBias = FMath::Lerp(2.0f, 0.0f, Daylight);
}
