#pragma once

#include "CoreMinimal.h"

/** Walkable street/footpath network loaded from the baked paths file, in world coordinates. */
struct FPedestrianGraph
{
	struct FEdge
	{
		int32 To = INDEX_NONE;
		uint8 Class = 0; // 0 footpath, 1 quiet street, 2 main road
	};

	TArray<FVector> Nodes;
	TArray<TArray<FEdge>> Adjacency;

	bool IsValid() const { return Nodes.Num() > 1; }

	/** Loads `Path` (an absolute file path) and projects nodes around the given origin. Logs and returns false on failure. */
	bool LoadFromFile(const FString& Path, double OriginLatitude, double OriginLongitude);

	/** Class of the edge between two nodes, or 1 (quiet street) if they are not adjacent. */
	uint8 EdgeClass(int32 From, int32 To) const;
};
