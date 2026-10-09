#include "Npc/CrowdSim.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace BudapestCrowd
{
	float DensityForHour(float Hour)
	{
		// Fraction of the peak population out at each local hour: quiet nights, rush hours around 8 and 17, a lunch bump.
		static const float Hourly[24] =
		{
			0.04f, 0.03f, 0.02f, 0.02f, 0.03f, 0.07f, // 00-05
			0.18f, 0.50f, 0.90f, 0.70f, 0.60f, 0.65f, // 06-11
			0.85f, 0.80f, 0.65f, 0.65f, 0.80f, 1.00f, // 12-17
			0.95f, 0.80f, 0.60f, 0.45f, 0.30f, 0.15f, // 18-23
		};

		if (!std::isfinite(Hour))
		{
			return Hourly[12];
		}
		float Wrapped = std::fmod(Hour, 24.0f);
		if (Wrapped < 0.0f)
		{
			Wrapped += 24.0f;
		}
		const int32_t Index = std::min(std::max(static_cast<int32_t>(std::floor(Wrapped)), 0), 23);
		const float Fraction = std::min(std::max(Wrapped - static_cast<float>(Index), 0.0f), 1.0f);
		const float Current = Hourly[Index];
		const float Next = Hourly[(Index + 1) % 24];
		return Current + (Next - Current) * Fraction;
	}

	double PavementOffsetCm(uint8_t EdgeClass)
	{
		// Footpaths: walk on them. Quiet streets and main roads: on the pavement beside the carriageway.
		static const double OffsetsCm[3] = { 60.0, 480.0, 750.0 };
		return OffsetsCm[std::min<int>(EdgeClass, 2)];
	}

	double EdgeClassWeight(uint8_t EdgeClass)
	{
		static const double Weights[3] = { 1.0, 2.0, 3.0 };
		return Weights[std::min<int>(EdgeClass, 2)];
	}

	FSim::FSim()
	{
		Reset(1);
	}

	void FSim::Reset(uint64_t Seed)
	{
		Agents.clear();
		FreeSlots.clear();
		AliveCount = 0;
		ControlledCount = 0;
		Target = 0;
		RngState = Seed;
	}

	void FSim::SetGraph(const std::vector<FNode>& InNodes, const std::vector<FEdge>& InEdges)
	{
		Agents.clear();
		FreeSlots.clear();
		AliveCount = 0;
		ControlledCount = 0;

		Nodes = InNodes;
		const int32_t NodeCount = static_cast<int32_t>(Nodes.size());
		auto IsUsable = [this, NodeCount](const FEdge& Edge) -> bool
		{
			if (Edge.A < 0 || Edge.B < 0 || Edge.A >= NodeCount || Edge.B >= NodeCount || Edge.A == Edge.B)
			{
				return false;
			}
			const FNode& EndA = Nodes[static_cast<size_t>(Edge.A)];
			const FNode& EndB = Nodes[static_cast<size_t>(Edge.B)];
			return std::isfinite(EndA.X) && std::isfinite(EndA.Y) && std::isfinite(EndB.X) && std::isfinite(EndB.Y);
		};

		// Compressed adjacency: count the links per node, then fill them in edge order.
		std::vector<int32_t> Degree(Nodes.size(), 0);
		for (const FEdge& Edge : InEdges)
		{
			if (IsUsable(Edge))
			{
				++Degree[static_cast<size_t>(Edge.A)];
				++Degree[static_cast<size_t>(Edge.B)];
			}
		}
		FirstLink.assign(Nodes.size() + 1, 0);
		for (size_t Node = 0; Node < Nodes.size(); ++Node)
		{
			FirstLink[Node + 1] = FirstLink[Node] + Degree[Node];
		}
		const size_t LinkCount = static_cast<size_t>(FirstLink.back());
		Links.assign(LinkCount, FLink());
		LinkFrom.assign(LinkCount, NoNode);

		std::vector<int32_t> Cursor(FirstLink.begin(), FirstLink.end() - 1);
		for (const FEdge& Edge : InEdges)
		{
			if (!IsUsable(Edge))
			{
				continue;
			}
			const FNode& EndA = Nodes[static_cast<size_t>(Edge.A)];
			const FNode& EndB = Nodes[static_cast<size_t>(Edge.B)];
			const double EdgeLength = std::max(1.0, std::hypot(EndB.X - EndA.X, EndB.Y - EndA.Y));

			const size_t Forward = static_cast<size_t>(Cursor[static_cast<size_t>(Edge.A)]++);
			Links[Forward].To = Edge.B;
			Links[Forward].Class = Edge.Class;
			Links[Forward].Length = EdgeLength;
			LinkFrom[Forward] = Edge.A;

			const size_t Backward = static_cast<size_t>(Cursor[static_cast<size_t>(Edge.B)]++);
			Links[Backward].To = Edge.A;
			Links[Backward].Class = Edge.Class;
			Links[Backward].Length = EdgeLength;
			LinkFrom[Backward] = Edge.B;
		}

		// New walkers appear in proportion to street length, more on busier streets.
		SpawnCumulative.assign(LinkCount, 0.0);
		double Running = 0.0;
		for (size_t Link = 0; Link < LinkCount; ++Link)
		{
			Running += Links[Link].Length * EdgeClassWeight(Links[Link].Class);
			SpawnCumulative[Link] = Running;
		}

		BuildGrid();
	}

	int32_t FSim::GetDegree(int32_t Node) const
	{
		if (Node < 0 || Node >= GetNodeCount() || FirstLink.size() != Nodes.size() + 1)
		{
			return 0;
		}
		return FirstLink[static_cast<size_t>(Node) + 1] - FirstLink[static_cast<size_t>(Node)];
	}

	const FNode* FSim::GetNode(int32_t Node) const
	{
		return Node >= 0 && Node < GetNodeCount() ? &Nodes[static_cast<size_t>(Node)] : nullptr;
	}

	void FSim::BuildGrid()
	{
		CellStart.clear();
		CellNodes.clear();
		GridWidth = 0;
		GridHeight = 0;

		double MinX = std::numeric_limits<double>::max();
		double MinY = std::numeric_limits<double>::max();
		double MaxX = std::numeric_limits<double>::lowest();
		double MaxY = std::numeric_limits<double>::lowest();
		bool bAnyWalkable = false;
		for (int32_t Node = 0; Node < GetNodeCount(); ++Node)
		{
			if (GetDegree(Node) > 0)
			{
				const FNode& Point = Nodes[static_cast<size_t>(Node)];
				MinX = std::min(MinX, Point.X);
				MinY = std::min(MinY, Point.Y);
				MaxX = std::max(MaxX, Point.X);
				MaxY = std::max(MaxY, Point.Y);
				bAnyWalkable = true;
			}
		}
		if (!bAnyWalkable)
		{
			return;
		}

		// 50 m cells, coarser if the network is huge so the grid stays at most ~1000 x 1000.
		CellSize = std::max(5000.0, std::max(MaxX - MinX, MaxY - MinY) / 1000.0);
		GridMinX = MinX;
		GridMinY = MinY;
		GridWidth = static_cast<int32_t>(std::floor((MaxX - MinX) / CellSize)) + 1;
		GridHeight = static_cast<int32_t>(std::floor((MaxY - MinY) / CellSize)) + 1;

		const size_t CellCount = static_cast<size_t>(GridWidth) * static_cast<size_t>(GridHeight);
		CellStart.assign(CellCount + 1, 0);
		for (int32_t Node = 0; Node < GetNodeCount(); ++Node)
		{
			if (GetDegree(Node) > 0)
			{
				int32_t CellX = 0;
				int32_t CellY = 0;
				GridCell(Nodes[static_cast<size_t>(Node)].X, Nodes[static_cast<size_t>(Node)].Y, CellX, CellY);
				++CellStart[static_cast<size_t>(CellY) * static_cast<size_t>(GridWidth) + static_cast<size_t>(CellX) + 1];
			}
		}
		for (size_t Cell = 0; Cell < CellCount; ++Cell)
		{
			CellStart[Cell + 1] += CellStart[Cell];
		}
		CellNodes.assign(static_cast<size_t>(CellStart.back()), NoNode);
		std::vector<int32_t> Fill(CellStart.begin(), CellStart.end() - 1);
		for (int32_t Node = 0; Node < GetNodeCount(); ++Node)
		{
			if (GetDegree(Node) > 0)
			{
				int32_t CellX = 0;
				int32_t CellY = 0;
				GridCell(Nodes[static_cast<size_t>(Node)].X, Nodes[static_cast<size_t>(Node)].Y, CellX, CellY);
				const size_t Cell = static_cast<size_t>(CellY) * static_cast<size_t>(GridWidth) + static_cast<size_t>(CellX);
				CellNodes[static_cast<size_t>(Fill[Cell]++)] = Node;
			}
		}
	}

	void FSim::GridCell(double X, double Y, int32_t& OutCellX, int32_t& OutCellY) const
	{
		// Clamped in floating point first so far-away (but finite) points cannot overflow the integer cast.
		const double CellX = std::min(std::max(std::floor((X - GridMinX) / CellSize), 0.0), static_cast<double>(GridWidth - 1));
		const double CellY = std::min(std::max(std::floor((Y - GridMinY) / CellSize), 0.0), static_cast<double>(GridHeight - 1));
		OutCellX = static_cast<int32_t>(CellX);
		OutCellY = static_cast<int32_t>(CellY);
	}

	int32_t FSim::FindNearestNode(double X, double Y) const
	{
		if (GridWidth <= 0 || GridHeight <= 0 || !std::isfinite(X) || !std::isfinite(Y))
		{
			return NoNode;
		}

		int32_t CenterX = 0;
		int32_t CenterY = 0;
		GridCell(X, Y, CenterX, CenterY);

		int32_t Best = NoNode;
		double BestDistanceSq = std::numeric_limits<double>::max();
		const int32_t MaxRing = std::max(GridWidth, GridHeight);
		for (int32_t Ring = 0; Ring <= MaxRing; ++Ring)
		{
			// Everything in this ring of cells (and beyond) is at least Ring - 1 cells away.
			if (Best != NoNode && Ring > 0)
			{
				const double Reach = static_cast<double>(Ring - 1) * CellSize;
				if (Reach * Reach >= BestDistanceSq)
				{
					break;
				}
			}
			for (int32_t CellY = CenterY - Ring; CellY <= CenterY + Ring; ++CellY)
			{
				if (CellY < 0 || CellY >= GridHeight)
				{
					continue;
				}
				// Inner rows of the ring only have their two end cells.
				const bool bFullRow = CellY == CenterY - Ring || CellY == CenterY + Ring;
				const int32_t StepX = bFullRow ? 1 : 2 * Ring;
				for (int32_t CellX = CenterX - Ring; CellX <= CenterX + Ring; CellX += StepX)
				{
					if (CellX < 0 || CellX >= GridWidth)
					{
						continue;
					}
					const size_t Cell = static_cast<size_t>(CellY) * static_cast<size_t>(GridWidth) + static_cast<size_t>(CellX);
					for (int32_t Slot = CellStart[Cell]; Slot < CellStart[Cell + 1]; ++Slot)
					{
						const int32_t Node = CellNodes[static_cast<size_t>(Slot)];
						const FNode& Point = Nodes[static_cast<size_t>(Node)];
						const double DistanceSq = (Point.X - X) * (Point.X - X) + (Point.Y - Y) * (Point.Y - Y);
						if (Best == NoNode || DistanceSq < BestDistanceSq) // (the first test keeps absurdly far queries, whose squares overflow, answered)
						{
							BestDistanceSq = DistanceSq;
							Best = Node;
						}
					}
				}
			}
		}
		return Best;
	}

	int32_t FSim::FindLink(int32_t From, int32_t To) const
	{
		if (GetDegree(From) <= 0)
		{
			return NoNode;
		}
		for (int32_t Link = FirstLink[static_cast<size_t>(From)]; Link < FirstLink[static_cast<size_t>(From) + 1]; ++Link)
		{
			if (Links[static_cast<size_t>(Link)].To == To)
			{
				return Link;
			}
		}
		return NoNode;
	}

	int32_t FSim::PickNextLink(int32_t From, int32_t Current, double Random) const
	{
		if (GetDegree(Current) <= 0)
		{
			return NoNode;
		}
		const int32_t Begin = FirstLink[static_cast<size_t>(Current)];
		const int32_t End = FirstLink[static_cast<size_t>(Current) + 1];

		// Busier streets draw more foot traffic than footpaths and back lanes.
		double Total = 0.0;
		for (int32_t Link = Begin; Link < End; ++Link)
		{
			if (Links[static_cast<size_t>(Link)].To != From)
			{
				Total += EdgeClassWeight(Links[static_cast<size_t>(Link)].Class);
			}
		}
		if (Total <= 0.0)
		{
			return Begin; // dead end: every street leads back where we came from, so turn round
		}

		double Pick = Random * Total;
		int32_t Last = Begin;
		for (int32_t Link = Begin; Link < End; ++Link)
		{
			if (Links[static_cast<size_t>(Link)].To == From)
			{
				continue;
			}
			Last = Link;
			Pick -= EdgeClassWeight(Links[static_cast<size_t>(Link)].Class);
			if (Pick <= 0.0)
			{
				return Link;
			}
		}
		return Last; // floating-point leftovers (or a NaN random number)
	}

	int32_t FSim::PickFleeLink(int32_t From, int32_t Current, double ThreatX, double ThreatY, double Random) const
	{
		if (GetDegree(Current) <= 0)
		{
			return NoNode;
		}
		const int32_t Begin = FirstLink[static_cast<size_t>(Current)];
		const int32_t End = FirstLink[static_cast<size_t>(Current) + 1];
		const FNode& Here = Nodes[static_cast<size_t>(Current)];
		const double HereDistance = std::hypot(Here.X - ThreatX, Here.Y - ThreatY);

		// Weight each street by how directly it leads away (gained distance per distance walked), squared so
		// people mostly take the straightest way out. Going back the way they came is a little less likely.
		int32_t BestLink = Begin;
		double BestGain = std::numeric_limits<double>::lowest();
		double Total = 0.0;
		for (int32_t Link = Begin; Link < End; ++Link)
		{
			const FLink& Street = Links[static_cast<size_t>(Link)];
			const FNode& There = Nodes[static_cast<size_t>(Street.To)];
			const double Gain = std::hypot(There.X - ThreatX, There.Y - ThreatY) - HereDistance;
			if (Gain > BestGain)
			{
				BestGain = Gain;
				BestLink = Link;
			}
			if (Gain > 0.0)
			{
				const double Directness = std::min(1.0, Gain / Street.Length);
				Total += Directness * Directness * (Street.To == From ? 0.5 : 1.0);
			}
		}
		if (Total <= 0.0)
		{
			return BestLink; // cornered: take the street that loses the least ground
		}

		double Pick = Random * Total;
		for (int32_t Link = Begin; Link < End; ++Link)
		{
			const FLink& Street = Links[static_cast<size_t>(Link)];
			const FNode& There = Nodes[static_cast<size_t>(Street.To)];
			const double Gain = std::hypot(There.X - ThreatX, There.Y - ThreatY) - HereDistance;
			if (Gain <= 0.0)
			{
				continue;
			}
			const double Directness = std::min(1.0, Gain / Street.Length);
			Pick -= Directness * Directness * (Street.To == From ? 0.5 : 1.0);
			if (Pick <= 0.0)
			{
				return Link;
			}
		}
		return BestLink;
	}

	int32_t FSim::PickNextNode(int32_t From, int32_t Current, double Random) const
	{
		const int32_t Link = PickNextLink(From, Current, Random);
		return Link >= 0 ? Links[static_cast<size_t>(Link)].To : NoNode;
	}

	int32_t FSim::PickFleeNode(int32_t From, int32_t Current, double ThreatX, double ThreatY, double Random) const
	{
		const int32_t Link = PickFleeLink(From, Current, ThreatX, ThreatY, Random);
		return Link >= 0 ? Links[static_cast<size_t>(Link)].To : NoNode;
	}

	void FSim::EnterLink(FAgent& Agent, int32_t Link) const
	{
		const FLink& Street = Links[static_cast<size_t>(Link)];
		Agent.To = Street.To;
		Agent.Length = Street.Length;
		Agent.Class = Street.Class;
	}

	void FSim::CurrentOffset(const FAgent& Agent, double& OutX, double& OutY) const
	{
		const FNode& EndA = Nodes[static_cast<size_t>(Agent.From)];
		const FNode& EndB = Nodes[static_cast<size_t>(Agent.To)];
		const double Dx = EndB.X - EndA.X;
		const double Dy = EndB.Y - EndA.Y;
		const double EdgeLength = std::sqrt(Dx * Dx + Dy * Dy);
		if (EdgeLength < 1e-6)
		{
			// Two junctions on the same spot: keep whatever offset we had.
			OutX = Agent.bRoundingCorner ? Agent.PrevOffsetX : 0.0;
			OutY = Agent.bRoundingCorner ? Agent.PrevOffsetY : 0.0;
			return;
		}
		// Perpendicular in the horizontal plane (X = north, Y = east): +Side is the right-hand pavement.
		const double Offset = PavementOffsetCm(Agent.Class) * Agent.Side * Agent.OffsetJitter;
		OutX = -Dy / EdgeLength * Offset;
		OutY = Dx / EdgeLength * Offset;
	}

	void FSim::ComputePose(const FAgent& Agent, FPose& Out) const
	{
		const FNode& EndA = Nodes[static_cast<size_t>(Agent.From)];
		const FNode& EndB = Nodes[static_cast<size_t>(Agent.To)];
		const double Dx = EndB.X - EndA.X;
		const double Dy = EndB.Y - EndA.Y;
		const double EdgeLength = std::sqrt(Dx * Dx + Dy * Dy);
		const double Along = std::min(std::max(Agent.Distance / Agent.Length, 0.0), 1.0);

		double OffsetX = 0.0;
		double OffsetY = 0.0;
		CurrentOffset(Agent, OffsetX, OffsetY);
		if (Agent.bRoundingCorner)
		{
			// Swing from the previous street's pavement to this one's over the first few metres, so walkers
			// round corners (and turn back at dead ends) without jumping.
			const double Blend = std::min(Settings.CornerBlendCm, 0.5 * Agent.Length);
			if (Blend > 0.0 && Agent.Distance < Blend)
			{
				double Smooth = std::max(Agent.Distance, 0.0) / Blend;
				Smooth = Smooth * Smooth * (3.0 - 2.0 * Smooth);
				OffsetX = Agent.PrevOffsetX + (OffsetX - Agent.PrevOffsetX) * Smooth;
				OffsetY = Agent.PrevOffsetY + (OffsetY - Agent.PrevOffsetY) * Smooth;
			}
		}

		Out.X = EndA.X + Dx * Along + OffsetX;
		Out.Y = EndA.Y + Dy * Along + OffsetY;
		if (EdgeLength > 1e-6)
		{
			Out.DirX = Dx / EdgeLength;
			Out.DirY = Dy / EdgeLength;
		}
		else
		{
			Out.DirX = 1.0;
			Out.DirY = 0.0;
		}
	}

	void FSim::Advance(FAgent& Agent)
	{
		// Where the pavement was at the end of the street we are leaving, to swing round the corner from it.
		CurrentOffset(Agent, Agent.PrevOffsetX, Agent.PrevOffsetY);

		const int32_t Link = Agent.PanicSeconds > 0.0
			? PickFleeLink(Agent.From, Agent.To, Agent.ThreatX, Agent.ThreatY, Random01())
			: PickNextLink(Agent.From, Agent.To, Random01());
		if (Link < 0)
		{
			// Cannot happen (the street we arrived on leads back), but never leave an agent stranded.
			std::swap(Agent.From, Agent.To);
			Agent.Side = -Agent.Side;
			Agent.Distance = 0.0;
			Agent.bRoundingCorner = false;
			return;
		}

		if (Links[static_cast<size_t>(Link)].To == Agent.From)
		{
			Agent.Side = -Agent.Side; // turning back: stay on the same pavement
		}
		Agent.From = Agent.To;
		EnterLink(Agent, Link);
		Agent.bRoundingCorner = true;
	}

	void FSim::Step(double Dt)
	{
		if (!(Dt > 0.0) || Links.empty())
		{
			return;
		}
		Dt = std::min(Dt, 2.0);

		AdjustPopulation(Dt, false);

		for (FAgent& Agent : Agents)
		{
			if (!Agent.bAlive || Agent.bControlled)
			{
				continue;
			}

			double SpeedNow = Agent.Speed;
			if (Agent.PanicSeconds > 0.0)
			{
				SpeedNow *= Settings.PanicSpeedFactor;
				Agent.PanicSeconds = std::max(0.0, Agent.PanicSeconds - Dt);
			}
			Agent.Distance += SpeedNow * Dt;

			// Usually at most one junction per step; the cap only matters for runs of tiny edges.
			for (int32_t Junctions = 0; Agent.Distance >= Agent.Length && Junctions < 64; ++Junctions)
			{
				Agent.Distance -= Agent.Length;
				Advance(Agent);
			}
			Agent.Distance = std::min(std::max(Agent.Distance, 0.0), Agent.Length);
		}
	}

	int32_t FSim::Flee(double X, double Y, double Radius)
	{
		if (!(Radius > 0.0) || !std::isfinite(X) || !std::isfinite(Y) || Nodes.empty())
		{
			return 0;
		}

		const double RadiusSq = Radius * Radius;
		int32_t Frightened = 0;
		for (FAgent& Agent : Agents)
		{
			if (!Agent.bAlive || Agent.bControlled)
			{
				continue;
			}
			FPose Pose;
			ComputePose(Agent, Pose);
			const double ToThreatX = X - Pose.X;
			const double ToThreatY = Y - Pose.Y;
			if (ToThreatX * ToThreatX + ToThreatY * ToThreatY > RadiusSq)
			{
				continue;
			}

			Agent.PanicSeconds = Settings.PanicSeconds * (0.85 + 0.3 * Random01());
			Agent.ThreatX = X;
			Agent.ThreatY = Y;

			// Walking towards the danger? Turn round on the spot, keeping to the same pavement.
			if (Pose.DirX * ToThreatX + Pose.DirY * ToThreatY > 0.0)
			{
				std::swap(Agent.From, Agent.To);
				Agent.Distance = std::max(0.0, Agent.Length - Agent.Distance);
				Agent.Side = -Agent.Side;
				Agent.bRoundingCorner = false;
			}
			++Frightened;
		}
		return Frightened;
	}

	void FSim::SetTarget(int32_t Count, bool bImmediate)
	{
		Target = std::min(std::max(Count, 0), 1000000);
		if (bImmediate)
		{
			AdjustPopulation(0.0, true);
		}
	}

	void FSim::SetQuietZone(double X, double Y, double Radius)
	{
		const bool bValid = std::isfinite(X) && std::isfinite(Y) && std::isfinite(Radius) && Radius > 0.0;
		QuietX = bValid ? X : 0.0;
		QuietY = bValid ? Y : 0.0;
		QuietRadius = bValid ? Radius : 0.0;
	}

	bool FSim::InQuietZone(double X, double Y) const
	{
		return QuietRadius > 0.0 && (X - QuietX) * (X - QuietX) + (Y - QuietY) * (Y - QuietY) < QuietRadius * QuietRadius;
	}

	void FSim::AdjustPopulation(double Dt, bool bImmediate)
	{
		if (Links.empty())
		{
			return;
		}
		const int32_t Gap = Target - AliveCount;
		if (Gap == 0)
		{
			return;
		}

		// Close a fraction of the gap per second (at least one agent per step), so the street never visibly pops.
		const int32_t Missing = Gap > 0 ? Gap : -Gap;
		int32_t Budget = Missing;
		if (!bImmediate)
		{
			const double Fraction = std::min(1.0, Dt / std::max(1e-3, Settings.PopulationTimeConstant));
			Budget = std::min(Missing, std::max(1, static_cast<int32_t>(std::ceil(static_cast<double>(Missing) * Fraction))));
		}
		for (int32_t Change = 0; Change < Budget; ++Change)
		{
			const bool bChanged = Gap > 0 ? AddOne(!bImmediate) : RemoveOne(!bImmediate);
			if (!bChanged)
			{
				break;
			}
		}
	}

	bool FSim::AddOne(bool bRespectQuietZone)
	{
		if (SpawnCumulative.empty() || !(SpawnCumulative.back() > 0.0))
		{
			return false;
		}

		for (int32_t Attempt = 0; Attempt < 8; ++Attempt)
		{
			const double Pick = Random01() * SpawnCumulative.back();
			size_t Link = static_cast<size_t>(std::upper_bound(SpawnCumulative.begin(), SpawnCumulative.end(), Pick) - SpawnCumulative.begin());
			Link = std::min(Link, Links.size() - 1);

			FAgent Agent;
			Agent.From = LinkFrom[Link];
			EnterLink(Agent, static_cast<int32_t>(Link));
			Agent.Distance = Random01() * Agent.Length;
			Agent.Speed = Settings.MinSpeed + (Settings.MaxSpeed - Settings.MinSpeed) * Random01();
			Agent.Side = Random01() < 0.5 ? -1.0 : 1.0;
			Agent.OffsetJitter = 0.8 + 0.4 * Random01();
			Agent.Seed = static_cast<uint32_t>(NextRandom() >> 34) + 1u; // 1 .. 2^30, fits a signed 32-bit seed
			Agent.bAlive = true;

			if (bRespectQuietZone)
			{
				FPose Pose;
				ComputePose(Agent, Pose);
				if (InQuietZone(Pose.X, Pose.Y))
				{
					continue;
				}
			}

			if (!FreeSlots.empty())
			{
				Agents[static_cast<size_t>(FreeSlots.back())] = Agent;
				FreeSlots.pop_back();
			}
			else
			{
				Agents.push_back(Agent);
			}
			++AliveCount;
			return true;
		}
		return false;
	}

	bool FSim::RemoveOne(bool bRespectQuietZone)
	{
		const int32_t Slots = GetSlotCount();
		if (Slots == 0 || AliveCount - ControlledCount <= 0)
		{
			return false;
		}

		// Start the search at a random slot so whoever goes home is picked at random.
		const int32_t Start = std::min(static_cast<int32_t>(Random01() * static_cast<double>(Slots)), Slots - 1);
		for (int32_t Offset = 0; Offset < Slots; ++Offset)
		{
			const int32_t Index = (Start + Offset) % Slots;
			const FAgent& Agent = Agents[static_cast<size_t>(Index)];
			if (!Agent.bAlive || Agent.bControlled)
			{
				continue;
			}
			if (bRespectQuietZone)
			{
				FPose Pose;
				ComputePose(Agent, Pose);
				if (InQuietZone(Pose.X, Pose.Y))
				{
					continue;
				}
			}
			FreeSlot(Index);
			return true;
		}
		return false;
	}

	void FSim::FreeSlot(int32_t Index)
	{
		FAgent& Agent = Agents[static_cast<size_t>(Index)];
		if (!Agent.bAlive)
		{
			return;
		}
		if (Agent.bControlled)
		{
			--ControlledCount;
		}
		Agent = FAgent();
		--AliveCount;
		FreeSlots.push_back(Index);
	}

	const FAgent* FSim::GetAgent(int32_t Index) const
	{
		if (Index < 0 || Index >= GetSlotCount() || !Agents[static_cast<size_t>(Index)].bAlive)
		{
			return nullptr;
		}
		return &Agents[static_cast<size_t>(Index)];
	}

	bool FSim::GetPose(int32_t Index, FPose& Out) const
	{
		const FAgent* Agent = GetAgent(Index);
		if (Agent == nullptr)
		{
			return false;
		}
		ComputePose(*Agent, Out);
		return true;
	}

	bool FSim::Detach(int32_t Index)
	{
		if (Index < 0 || Index >= GetSlotCount())
		{
			return false;
		}
		FAgent& Agent = Agents[static_cast<size_t>(Index)];
		if (!Agent.bAlive || Agent.bControlled)
		{
			return false;
		}
		Agent.bControlled = true;
		++ControlledCount;
		return true;
	}

	bool FSim::Attach(int32_t Index, const FHandBack& State)
	{
		if (Index < 0 || Index >= GetSlotCount())
		{
			return false;
		}
		FAgent& Agent = Agents[static_cast<size_t>(Index)];
		const int32_t Link = FindLink(State.From, State.To);
		if (!Agent.bAlive || !Agent.bControlled || Link < 0)
		{
			return false;
		}

		Agent.From = State.From;
		EnterLink(Agent, Link);
		Agent.Distance = std::isfinite(State.Distance) ? std::min(std::max(State.Distance, 0.0), Agent.Length) : 0.0;
		Agent.Side = State.Side < 0.0 ? -1.0 : 1.0;
		const bool bThreatValid = std::isfinite(State.ThreatX) && std::isfinite(State.ThreatY);
		Agent.PanicSeconds = (bThreatValid && std::isfinite(State.PanicSeconds)) ? std::min(std::max(State.PanicSeconds, 0.0), 600.0) : 0.0;
		Agent.ThreatX = bThreatValid ? State.ThreatX : 0.0;
		Agent.ThreatY = bThreatValid ? State.ThreatY : 0.0;
		Agent.bRoundingCorner = false;
		Agent.bControlled = false;
		--ControlledCount;
		return true;
	}

	bool FSim::Kill(int32_t Index)
	{
		if (GetAgent(Index) == nullptr)
		{
			return false;
		}
		FreeSlot(Index);
		return true;
	}

	bool FSim::ProjectOntoEdge(int32_t From, int32_t To, double X, double Y, double& OutDistance) const
	{
		const int32_t Link = FindLink(From, To);
		if (Link < 0)
		{
			return false;
		}
		const FNode& EndA = Nodes[static_cast<size_t>(From)];
		const FNode& EndB = Nodes[static_cast<size_t>(To)];
		const double Dx = EndB.X - EndA.X;
		const double Dy = EndB.Y - EndA.Y;
		const double LengthSq = Dx * Dx + Dy * Dy;
		double Along = 0.0;
		if (LengthSq > 1e-12 && std::isfinite(X) && std::isfinite(Y))
		{
			Along = std::min(std::max(((X - EndA.X) * Dx + (Y - EndA.Y) * Dy) / LengthSq, 0.0), 1.0);
		}
		OutDistance = Along * Links[static_cast<size_t>(Link)].Length;
		return true;
	}

	uint64_t FSim::NextRandom()
	{
		// SplitMix64: tiny, fast, and the same sequence on every platform and standard library.
		RngState += 0x9E3779B97F4A7C15ull;
		uint64_t Mixed = RngState;
		Mixed = (Mixed ^ (Mixed >> 30)) * 0xBF58476D1CE4E5B9ull;
		Mixed = (Mixed ^ (Mixed >> 27)) * 0x94D049BB133111EBull;
		return Mixed ^ (Mixed >> 31);
	}

	double FSim::Random01()
	{
		return static_cast<double>(NextRandom() >> 11) * (1.0 / 9007199254740992.0);
	}
}
