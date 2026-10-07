#include "Game/BudapestPawn.h"

#include "Components/InputComponent.h"
#include "EngineUtils.h"
#include "GameFramework/FloatingPawnMovement.h"
#include "GameFramework/PlayerController.h"
#include "InputCoreTypes.h"
#include "World/DayCycleActor.h"

namespace
{
	const float TimeScaleSteps[] = { 1.0f, 10.0f, 60.0f, 600.0f, 3600.0f };
}

ABudapestPawn::ABudapestPawn()
{
	if (UFloatingPawnMovement* Movement = Cast<UFloatingPawnMovement>(GetMovementComponent()))
	{
		// Engine defaults suit a room, not a district: 300 m/s cruise, snappy start/stop.
		Movement->MaxSpeed = 30000.0f;
		Movement->Acceleration = 60000.0f;
		Movement->Deceleration = 60000.0f;
	}
}

void ABudapestPawn::PossessedBy(AController* NewController)
{
	Super::PossessedBy(NewController);

	// Start 400 m south of the district centre, 250 m up, looking north and down at the roofs.
	BirdsEyeLocation = FVector(-40000.0, 0.0, 25000.0);
	SetActorLocation(BirdsEyeLocation);
	if (NewController != nullptr)
	{
		NewController->SetControlRotation(FRotator(-25.0, 0.0, 0.0));
	}
}

void ABudapestPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);

	PlayerInputComponent->BindKey(EKeys::G, IE_Pressed, this, &ABudapestPawn::ToggleStreetLevel);
	PlayerInputComponent->BindKey(EKeys::Comma, IE_Pressed, this, &ABudapestPawn::SlowerTime);
	PlayerInputComponent->BindKey(EKeys::Period, IE_Pressed, this, &ABudapestPawn::FasterTime);
	PlayerInputComponent->BindKey(EKeys::T, IE_Pressed, this, &ABudapestPawn::RealTime);
}

void ABudapestPawn::ToggleStreetLevel()
{
	if (bAtStreetLevel)
	{
		SetActorLocation(BirdsEyeLocation);
	}
	else
	{
		BirdsEyeLocation = GetActorLocation();
		SetActorLocation(FVector(BirdsEyeLocation.X, BirdsEyeLocation.Y, 170.0)); // eye height
		if (AController* PlayerController = GetController())
		{
			PlayerController->SetControlRotation(FRotator(0.0, PlayerController->GetControlRotation().Yaw, 0.0));
		}
	}
	bAtStreetLevel = !bAtStreetLevel;
}

ADayCycleActor* ABudapestPawn::FindDayCycle() const
{
	for (TActorIterator<ADayCycleActor> It(GetWorld()); It; ++It)
	{
		return *It;
	}
	return nullptr;
}

void ABudapestPawn::SetTimeOfDay(float Hour)
{
	if (ADayCycleActor* DayCycle = FindDayCycle())
	{
		DayCycle->SetLocalHour(Hour);
	}
}

void ABudapestPawn::SetTimeScale(float Scale)
{
	if (ADayCycleActor* DayCycle = FindDayCycle())
	{
		DayCycle->SetTimeScale(Scale);
	}
}

void ABudapestPawn::SlowerTime()
{
	StepTimeScale(-1);
}

void ABudapestPawn::FasterTime()
{
	StepTimeScale(+1);
}

void ABudapestPawn::RealTime()
{
	if (ADayCycleActor* DayCycle = FindDayCycle())
	{
		DayCycle->SyncToRealTime();
		DayCycle->SetTimeScale(1.0f);
	}
}

void ABudapestPawn::StepTimeScale(int32 Direction)
{
	ADayCycleActor* DayCycle = FindDayCycle();
	if (DayCycle == nullptr)
	{
		return;
	}

	// Move to the next preset above/below the current speed.
	const int32 Count = UE_ARRAY_COUNT(TimeScaleSteps);
	int32 Index = 0;
	for (int32 I = 0; I < Count; ++I)
	{
		if (DayCycle->GetTimeScale() >= TimeScaleSteps[I] - 0.01f)
		{
			Index = I;
		}
	}
	DayCycle->SetTimeScale(TimeScaleSteps[FMath::Clamp(Index + Direction, 0, Count - 1)]);
}
