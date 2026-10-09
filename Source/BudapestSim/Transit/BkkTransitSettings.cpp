#include "Transit/BkkTransitSettings.h"

#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

UBkkTransitSettings::UBkkTransitSettings()
{
	VehiclePositionsUrlTemplate = TEXT("https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb?key={key}");
}

FString UBkkTransitSettings::ResolveApiKey() const
{
	const FString EnvKey = FPlatformMisc::GetEnvironmentVariable(TEXT("BKK_API_KEY")).TrimStartAndEnd();
	if (!EnvKey.IsEmpty())
	{
		return EnvKey;
	}

	const FString SettingsKey = ApiKey.TrimStartAndEnd();
	if (!SettingsKey.IsEmpty())
	{
		return SettingsKey;
	}

	// Cached so the file is read once, not on every poll.
	static FString FileKey;
	static bool bTriedFile = false;
	if (!bTriedFile && !ApiKeyFileName.IsEmpty())
	{
		bTriedFile = true;
		FString Contents;
		if (FFileHelper::LoadFileToString(Contents, *FPaths::Combine(FPaths::ProjectDir(), ApiKeyFileName)))
		{
			FileKey = Contents.TrimStartAndEnd();
		}
	}
	return FileKey;
}
