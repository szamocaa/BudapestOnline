#include "City/BuildingMesher.h"

#include <cmath>

namespace CityMesh
{
namespace
{
	void PushVertex(FBuffer& Buffer, double X, double Y, double Z, double NX, double NY, double NZ, double OriginX, double OriginY)
	{
		Buffer.Positions.push_back(static_cast<float>(X - OriginX));
		Buffer.Positions.push_back(static_cast<float>(Y - OriginY));
		Buffer.Positions.push_back(static_cast<float>(Z));
		Buffer.Normals.push_back(static_cast<float>(NX));
		Buffer.Normals.push_back(static_cast<float>(NY));
		Buffer.Normals.push_back(static_cast<float>(NZ));
	}

	void PushTriangle(FBuffer& Buffer, uint32_t A, uint32_t B, uint32_t C)
	{
		Buffer.Indices.push_back(A);
		Buffer.Indices.push_back(B);
		Buffer.Indices.push_back(C);
	}
}

double SignedArea(const std::vector<FPoint2>& Ring)
{
	double Sum = 0.0;
	for (size_t I = 0, N = Ring.size(); I < N; ++I)
	{
		const FPoint2& A = Ring[I];
		const FPoint2& B = Ring[(I + 1) % N];
		Sum += A.X * B.Y - B.X * A.Y;
	}
	return 0.5 * Sum;
}

bool AppendBuilding(const std::vector<std::vector<FPoint2>>& Rings,
	const std::vector<uint32_t>& RoofIndices,
	double BaseZ,
	double TopZ,
	double OriginX,
	double OriginY,
	FBuffer& OutWalls,
	FBuffer& OutRoof)
{
	if (Rings.empty() || !(TopZ > BaseZ) || RoofIndices.size() % 3 != 0)
	{
		return false;
	}

	std::vector<FPoint2> Flat;
	for (const std::vector<FPoint2>& Ring : Rings)
	{
		if (Ring.size() < 3)
		{
			return false;
		}
		Flat.insert(Flat.end(), Ring.begin(), Ring.end());
	}
	for (uint32_t Index : RoofIndices)
	{
		if (Index >= Flat.size())
		{
			return false;
		}
	}

	// Walls: one flat-shaded quad per edge, facing away from the solid.
	for (size_t RingIndex = 0; RingIndex < Rings.size(); ++RingIndex)
	{
		const std::vector<FPoint2>& Ring = Rings[RingIndex];
		const double Area = SignedArea(Ring);
		const bool bIsOuter = RingIndex == 0;
		// Outer ring running +X->+Y keeps the solid on its left, so "outward" is to the right of travel.
		// A hole is the opposite: the solid lies outside the ring, so outward (into the void) flips.
		const bool bOutwardIsRight = bIsOuter == (Area > 0.0);

		for (size_t I = 0, N = Ring.size(); I < N; ++I)
		{
			const FPoint2& A = Ring[I];
			const FPoint2& B = Ring[(I + 1) % N];
			const double DX = B.X - A.X;
			const double DY = B.Y - A.Y;
			const double Length = std::sqrt(DX * DX + DY * DY);
			if (Length < 1e-9)
			{
				continue;
			}

			// Right of travel is (DY, -DX); left is (-DY, DX).
			const double SideSign = bOutwardIsRight ? 1.0 : -1.0;
			const double NX = SideSign * DY / Length;
			const double NY = -SideSign * DX / Length;

			const uint32_t Base = static_cast<uint32_t>(OutWalls.VertexCount());
			PushVertex(OutWalls, A.X, A.Y, BaseZ, NX, NY, 0.0, OriginX, OriginY);
			PushVertex(OutWalls, B.X, B.Y, BaseZ, NX, NY, 0.0, OriginX, OriginY);
			PushVertex(OutWalls, B.X, B.Y, TopZ, NX, NY, 0.0, OriginX, OriginY);
			PushVertex(OutWalls, A.X, A.Y, TopZ, NX, NY, 0.0, OriginX, OriginY);
			if (bOutwardIsRight)
			{
				PushTriangle(OutWalls, Base + 0, Base + 1, Base + 2);
				PushTriangle(OutWalls, Base + 0, Base + 2, Base + 3);
			}
			else
			{
				PushTriangle(OutWalls, Base + 0, Base + 2, Base + 1);
				PushTriangle(OutWalls, Base + 0, Base + 3, Base + 2);
			}
		}
	}

	// Roof: the baked triangulation has arbitrary winding, so orient each triangle to face up.
	const uint32_t RoofBase = static_cast<uint32_t>(OutRoof.VertexCount());
	for (const FPoint2& Point : Flat)
	{
		PushVertex(OutRoof, Point.X, Point.Y, TopZ, 0.0, 0.0, 1.0, OriginX, OriginY);
	}
	for (size_t I = 0; I + 2 < RoofIndices.size(); I += 3)
	{
		const FPoint2& A = Flat[RoofIndices[I]];
		const FPoint2& B = Flat[RoofIndices[I + 1]];
		const FPoint2& C = Flat[RoofIndices[I + 2]];
		const double CrossZ = (B.X - A.X) * (C.Y - A.Y) - (B.Y - A.Y) * (C.X - A.X);
		if (CrossZ > 0.0)
		{
			PushTriangle(OutRoof, RoofBase + RoofIndices[I], RoofBase + RoofIndices[I + 1], RoofBase + RoofIndices[I + 2]);
		}
		else if (CrossZ < 0.0)
		{
			PushTriangle(OutRoof, RoofBase + RoofIndices[I], RoofBase + RoofIndices[I + 2], RoofBase + RoofIndices[I + 1]);
		}
	}
	return true;
}
}
