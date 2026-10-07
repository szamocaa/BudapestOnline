#pragma once

#include "CoreMinimal.h"
#include "GameFramework/DefaultPawn.h"
#include "BudapestPawn.generated.h"

/**
 * Free-flying camera sized for a city: WASD + mouse to fly, Q/E down/up (the engine's default pawn bindings).
 * Extras: G toggles street level, , and . slow down / speed up the clock, T returns to real time.
 */
UCLASS()
class BUDAPESTSIM_API ABudapestPawn : public ADefaultPawn
{
	GENERATED_BODY()

public:
	ABudapestPawn();

	virtual void PossessedBy(AController* NewController) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	/** Jump between a human eye-height view of the street and a bird's-eye view. */
	UFUNCTION(Exec)
	void ToggleStreetLevel();

	/** Console: SetTimeOfDay 22.5 jumps to 22:30 Budapest time. */
	UFUNCTION(Exec)
	void SetTimeOfDay(float Hour);

	/** Console: SetTimeScale 60 makes one game minute pass per real second (1 = real time). */
	UFUNCTION(Exec)
	void SetTimeScale(float Scale);

private:
	void SlowerTime();
	void FasterTime();
	void RealTime();
	void StepTimeScale(int32 Direction);
	class ADayCycleActor* FindDayCycle() const;

	bool bAtStreetLevel = false;
	FVector BirdsEyeLocation = FVector::ZeroVector;
};
