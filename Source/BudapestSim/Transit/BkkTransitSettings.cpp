#include "Transit/BkkTransitSettings.h"

UBkkTransitSettings::UBkkTransitSettings()
{
	VehiclePositionsUrlTemplate = TEXT("https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb?key={key}");
}

FString UBkkTransitSettings::ResolveApiKey() const
{
	const FString EnvKey = FPlatformMisc::GetEnvironmentVariable(TEXT("BKK_API_KEY")).TrimStartAndEnd();
	return EnvKey.IsEmpty() ? ApiKey.TrimStartAndEnd() : EnvKey;
}
