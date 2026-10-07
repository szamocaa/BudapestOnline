#include "City/PedestrianGraph.h"

#include "BudapestSim.h"
#include "City/BsbReader.h"
#include "Misc/FileHelper.h"
#include "Transit/GeoProjection.h"

bool FPedestrianGraph::LoadFromFile(const FString& Path, double OriginLatitude, double OriginLongitude)
{
	Nodes.Reset();
	Adjacency.Reset();

	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *Path))
	{
		UE_LOG(LogBudapestSim, Warning, TEXT("Pedestrian paths not found: %s. Run Tools/Districts/bake_district.py to create them."), *Path);
		return false;
	}

	Bsb::FPaths Paths;
	if (!Bsb::ReadPaths(Bytes.GetData(), static_cast<size_t>(Bytes.Num()), Paths))
	{
		UE_LOG(LogBudapestSim, Error, TEXT("Pedestrian paths file is corrupt or has an unsupported version: %s"), *Path);
		return false;
	}

	Nodes.Reserve(static_cast<int32>(Paths.Nodes.size()));
	for (const Bsb::FPoint& Point : Paths.Nodes)
	{
		Nodes.Add(BudapestGeo::LatLonToWorld(Point.Latitude, Point.Longitude, OriginLatitude, OriginLongitude));
	}

	Adjacency.SetNum(Nodes.Num());
	for (const Bsb::FPathEdge& Edge : Paths.Edges)
	{
		FEdge Forward;
		Forward.To = static_cast<int32>(Edge.NodeB);
		Forward.Class = Edge.Class;
		Adjacency[static_cast<int32>(Edge.NodeA)].Add(Forward);

		FEdge Backward;
		Backward.To = static_cast<int32>(Edge.NodeA);
		Backward.Class = Edge.Class;
		Adjacency[static_cast<int32>(Edge.NodeB)].Add(Backward);
	}

	UE_LOG(LogBudapestSim, Log, TEXT("Pedestrian graph: %d nodes, %d edges"), Nodes.Num(), static_cast<int32>(Paths.Edges.size()));
	return IsValid();
}

uint8 FPedestrianGraph::EdgeClass(int32 From, int32 To) const
{
	if (Adjacency.IsValidIndex(From))
	{
		for (const FEdge& Edge : Adjacency[From])
		{
			if (Edge.To == To)
			{
				return Edge.Class;
			}
		}
	}
	return 1;
}
