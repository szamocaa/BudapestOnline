#pragma once

#include "CoreMinimal.h"
#include "Engine/EngineTypes.h"

/**
 * Project collision channels (declared in Config/DefaultEngine.ini).
 * Building: solid district buildings. The player and bullets are blocked by it; pedestrians ignore it
 * so a walker whose pavement offset clips a wall never gets stuck.
 */
namespace BudapestCollision
{
	constexpr ECollisionChannel Building = ECC_GameTraceChannel1;
}
