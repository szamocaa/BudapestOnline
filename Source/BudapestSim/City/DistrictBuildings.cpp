#include "City/DistrictBuildings.h"

#include "BudapestSim.h"
#include "City/BsbReader.h"
#include "City/BuildingMesher.h"
#include "Components/StaticMeshComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "ProceduralMeshComponent.h"
#include "Transit/BkkTransitSettings.h"
#include "Transit/GeoProjection.h"
#include "World/BudapestWorldSettings.h"

namespace
{
	// Typical Budapest plaster and render colours (linear).
	const FLinearColor WallTints[] =
	{
		FLinearColor(0.45f, 0.40f, 0.30f), // cream
		FLinearColor(0.40f, 0.28f, 0.12f), // ochre
		FLinearColor(0.50f, 0.42f, 0.18f), // pale yellow
		FLinearColor(0.30f, 0.30f, 0.29f), // light grey
		FLinearColor(0.34f, 0.17f, 0.12f), // terracotta
		FLinearColor(0.24f, 0.28f, 0.20f), // sage
	};
	constexpr int32 TintCount = UE_ARRAY_COUNT(WallTints);
	const FLinearColor RoofColor(0.06f, 0.05f, 0.045f);
	const FLinearColor GroundColor(0.07f, 0.07f, 0.075f);

	struct FChunkBuild
	{
		CityMesh::FBuffer Walls[TintCount];
		CityMesh::FBuffer Roof;
		double OriginX = 0.0;
		double OriginY = 0.0;
	};

	UMaterialInstanceDynamic* MakeMaterial(UObject* Outer, UMaterialInterface* Base, FName ColorParameter, const FLinearColor& Color)
	{
		if (Base == nullptr)
		{
			return nullptr;
		}
		UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(Base, Outer);
		if (Material != nullptr)
		{
			Material->SetVectorParameterValue(ColorParameter, Color);
		}
		return Material;
	}

	void AddSection(UProceduralMeshComponent* Mesh, int32 SectionIndex, const CityMesh::FBuffer& Buffer, UMaterialInterface* Material)
	{
		TArray<FVector> Vertices;
		TArray<FVector> Normals;
		TArray<int32> Triangles;
		const int32 VertexCount = static_cast<int32>(Buffer.VertexCount());
		Vertices.Reserve(VertexCount);
		Normals.Reserve(VertexCount);
		for (int32 I = 0; I < VertexCount; ++I)
		{
			const size_t Base = static_cast<size_t>(I) * 3;
			Vertices.Add(FVector(Buffer.Positions[Base], Buffer.Positions[Base + 1], Buffer.Positions[Base + 2]));
			Normals.Add(FVector(Buffer.Normals[Base], Buffer.Normals[Base + 1], Buffer.Normals[Base + 2]));
		}
		Triangles.Reserve(static_cast<int32>(Buffer.Indices.size()));
		for (uint32_t Index : Buffer.Indices)
		{
			Triangles.Add(static_cast<int32>(Index));
		}

		Mesh->CreateMeshSection_LinearColor(SectionIndex, Vertices, Triangles, Normals, TArray<FVector2D>(), TArray<FLinearColor>(), TArray<FProcMeshTangent>(), false);
		if (Material != nullptr)
		{
			Mesh->SetMaterial(SectionIndex, Material);
		}
	}
}

ADistrictBuildings::ADistrictBuildings()
{
	PrimaryActorTick.bCanEverTick = false;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	SetRootComponent(Root);

	Ground = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Ground"));
	Ground->SetupAttachment(Root);
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeAsset(TEXT("/Engine/BasicShapes/Cube.Cube"));
	if (CubeAsset.Succeeded())
	{
		Ground->SetStaticMesh(CubeAsset.Object);
	}
	Ground->SetCollisionProfileName(TEXT("BlockAll"));
	Ground->SetCastShadow(false);
}

void ADistrictBuildings::BeginPlay()
{
	Super::BeginPlay();

	UMaterialInterface* Base = SurfaceMaterial != nullptr
		? SurfaceMaterial.Get()
		: LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));

	if (bBuildGround)
	{
		// A 20 cm slab whose top face is exactly at Z = 0, so characters can stand on it.
		const float SideMeters = GroundHalfSizeKm * 2000.0f;
		Ground->SetWorldScale3D(FVector(SideMeters, SideMeters, 0.2f));
		Ground->SetWorldLocation(FVector(0.0, 0.0, -10.0));
		if (UMaterialInstanceDynamic* GroundMaterial = MakeMaterial(this, Base, ColorParameterName, GroundColor))
		{
			Ground->SetMaterial(0, GroundMaterial);
		}
	}
	else
	{
		Ground->SetVisibility(false);
		Ground->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	}

	if (!BuildBuildings())
	{
		UE_LOG(LogBudapestSim, Warning, TEXT("No district buildings loaded - the city will be empty. Generate them with: python3 Tools/Districts/bake_district.py all"));
	}
}

bool ADistrictBuildings::BuildBuildings()
{
	const UBudapestWorldSettings* WorldSettings = GetDefault<UBudapestWorldSettings>();
	const UBkkTransitSettings* Geo = GetDefault<UBkkTransitSettings>();

	const FString Path = FPaths::Combine(FPaths::ProjectContentDir(), WorldSettings->BuildingsFile);
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *Path))
	{
		UE_LOG(LogBudapestSim, Warning, TEXT("Buildings file not found: %s"), *Path);
		return false;
	}

	Bsb::FBuildings Data;
	if (!Bsb::ReadBuildings(Bytes.GetData(), static_cast<size_t>(Bytes.Num()), Data))
	{
		UE_LOG(LogBudapestSim, Error, TEXT("Buildings file is corrupt or has an unsupported version: %s"), *Path);
		return false;
	}

	const double ChunkCm = static_cast<double>(ChunkSizeMeters) * BudapestGeo::MetersToWorldUnits;
	TMap<int64, TUniquePtr<FChunkBuild>> Build;

	for (const Bsb::FBuilding& Building : Data.Items)
	{
		std::vector<std::vector<CityMesh::FPoint2>> Rings;
		Rings.reserve(Building.Rings.size());
		for (const std::vector<Bsb::FPoint>& Ring : Building.Rings)
		{
			std::vector<CityMesh::FPoint2> Projected;
			Projected.reserve(Ring.size());
			for (const Bsb::FPoint& Point : Ring)
			{
				const FVector World = BudapestGeo::LatLonToWorld(Point.Latitude, Point.Longitude, Geo->OriginLatitude, Geo->OriginLongitude);
				CityMesh::FPoint2 Out;
				Out.X = World.X;
				Out.Y = World.Y;
				Projected.push_back(Out);
			}
			Rings.push_back(std::move(Projected));
		}

		double CentroidX = 0.0;
		double CentroidY = 0.0;
		for (const CityMesh::FPoint2& Point : Rings[0])
		{
			CentroidX += Point.X;
			CentroidY += Point.Y;
		}
		CentroidX /= static_cast<double>(Rings[0].size());
		CentroidY /= static_cast<double>(Rings[0].size());

		const int32 CellX = FMath::FloorToInt(CentroidX / ChunkCm);
		const int32 CellY = FMath::FloorToInt(CentroidY / ChunkCm);
		const int64 Key = (static_cast<int64>(CellX) << 32) ^ static_cast<int64>(static_cast<uint32>(CellY));
		TUniquePtr<FChunkBuild>& Chunk = Build.FindOrAdd(Key);
		if (!Chunk.IsValid())
		{
			Chunk = MakeUnique<FChunkBuild>();
			Chunk->OriginX = (static_cast<double>(CellX) + 0.5) * ChunkCm;
			Chunk->OriginY = (static_cast<double>(CellY) + 0.5) * ChunkCm;
		}

		const double BaseZ = static_cast<double>(Building.MinHeightMeters) * BudapestGeo::MetersToWorldUnits;
		double TopZ = static_cast<double>(Building.HeightMeters) * BudapestGeo::MetersToWorldUnits;
		if (TopZ < BaseZ + 100.0)
		{
			TopZ = BaseZ + 300.0;
		}

		// Cheap deterministic hash so a building keeps its colour between runs.
		const int32 Tint = static_cast<int32>(((Building.OsmId * 11400714819323198485ULL) >> 58) % static_cast<uint64>(TintCount));
		if (CityMesh::AppendBuilding(Rings, Building.RoofIndices, BaseZ, TopZ, Chunk->OriginX, Chunk->OriginY, Chunk->Walls[Tint], Chunk->Roof))
		{
			++BuildingCount;
		}
	}

	UMaterialInterface* Base = SurfaceMaterial != nullptr
		? SurfaceMaterial.Get()
		: LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	UMaterialInstanceDynamic* TintMaterials[TintCount];
	for (int32 I = 0; I < TintCount; ++I)
	{
		TintMaterials[I] = MakeMaterial(this, Base, ColorParameterName, WallTints[I]);
	}
	UMaterialInstanceDynamic* RoofMaterial = MakeMaterial(this, Base, ColorParameterName, RoofColor);

	for (const TPair<int64, TUniquePtr<FChunkBuild>>& Pair : Build)
	{
		const FChunkBuild& Chunk = *Pair.Value;
		UProceduralMeshComponent* Mesh = NewObject<UProceduralMeshComponent>(this);
		Mesh->SetupAttachment(GetRootComponent());
		Mesh->RegisterComponent();
		Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Mesh->SetWorldLocation(FVector(Chunk.OriginX, Chunk.OriginY, 0.0));

		int32 Section = 0;
		for (int32 I = 0; I < TintCount; ++I)
		{
			if (!Chunk.Walls[I].Indices.empty())
			{
				AddSection(Mesh, Section++, Chunk.Walls[I], TintMaterials[I]);
			}
		}
		if (!Chunk.Roof.Indices.empty())
		{
			AddSection(Mesh, Section++, Chunk.Roof, RoofMaterial);
		}
		Chunks.Add(Mesh);
	}

	UE_LOG(LogBudapestSim, Log, TEXT("District buildings: %d buildings in %d chunks"), BuildingCount, Chunks.Num());
	return BuildingCount > 0;
}
