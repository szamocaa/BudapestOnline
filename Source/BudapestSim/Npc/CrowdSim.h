// District-wide pedestrian crowd: thousands of lightweight walkers on the street graph.
// Plain C++ (no Unreal types) so it can be tested outside the engine (Tools/CoreTests/crowd_test.cpp).
//
// Units and axes are the game's: centimetres, X = north, Y = east (see Transit/GeoProjection.h).
// Every agent walks along one edge of the street graph at a time, on the pavement beside the centre
// line (how far out depends on the street class), and picks its next street at each junction.
// ANpcManager turns the agents near the camera into full characters (Detach / Attach hand them over
// and back) and draws the ones further away as simple instanced figures.
//
// Everything is deterministic for a given seed and sequence of calls.
#pragma once

#include <cstdint>
#include <vector>

namespace BudapestCrowd
{
	constexpr int32_t NoNode = -1;

	struct FNode
	{
		double X = 0.0;
		double Y = 0.0;
	};

	/** Undirected street segment. Class as in the baked paths file: 0 footpath, 1 quiet street, 2 main road. */
	struct FEdge
	{
		int32_t A = NoNode;
		int32_t B = NoNode;
		uint8_t Class = 1;
	};

	struct FAgent
	{
		int32_t From = NoNode;     // junction the agent is walking away from
		int32_t To = NoNode;       // junction it is walking towards
		double Distance = 0.0;     // cm walked from From along the edge
		double Length = 1.0;       // length of the current edge (cm, at least 1)
		double Speed = 140.0;      // walking speed, cm/s
		double Side = 1.0;         // +1 pavement on the right of the walking direction, -1 on the left
		double OffsetJitter = 1.0; // personal scale on the pavement offset (0.8-1.2)
		double PanicSeconds = 0.0; // > 0 while running away from a threat
		double ThreatX = 0.0;
		double ThreatY = 0.0;
		double PrevOffsetX = 0.0;  // pavement offset at the end of the previous edge, to round corners smoothly
		double PrevOffsetY = 0.0;
		uint32_t Seed = 1;         // look seed, shared with the character that stands in for the agent
		uint8_t Class = 1;         // street class of the current edge
		bool bAlive = false;
		bool bControlled = false;  // a full character walks for it: the simulation leaves it alone
		bool bRoundingCorner = false;
	};

	/** Where an agent is: position on the pavement (cm) and walking direction (unit vector). */
	struct FPose
	{
		double X = 0.0;
		double Y = 0.0;
		double DirX = 1.0;
		double DirY = 0.0;
	};

	/** What a character hands back to the simulation when it turns into a lightweight agent again. */
	struct FHandBack
	{
		int32_t From = NoNode;
		int32_t To = NoNode;
		double Distance = 0.0;
		double Side = 1.0;
		double PanicSeconds = 0.0;
		double ThreatX = 0.0;
		double ThreatY = 0.0;
	};

	struct FSimSettings
	{
		double MinSpeed = 110.0;              // cm/s
		double MaxSpeed = 160.0;
		double PanicSeconds = 20.0;           // how long a frightened agent runs (+/-15%)
		double PanicSpeedFactor = 3.0;        // running speed relative to walking
		double PopulationTimeConstant = 2.0;  // seconds; the population closes this fraction of the gap per second
		double CornerBlendCm = 600.0;         // distance over which the pavement offset swings round a corner
	};

	/** Fraction (0-1) of the peak population out at a local Budapest hour (0-24, wraps). A plausible daily rhythm, not measured data. */
	float DensityForHour(float Hour);

	/** Distance from the street centre line to the pavement, by street class (footpath, quiet street, main road). */
	double PavementOffsetCm(uint8_t EdgeClass);

	/** Relative foot traffic by street class: busier streets draw more walkers. */
	double EdgeClassWeight(uint8_t EdgeClass);

	class FSim
	{
	public:
		FSim();

		/** Replaces the street graph and removes every agent. Self-loops and edges to missing nodes are ignored. */
		void SetGraph(const std::vector<FNode>& InNodes, const std::vector<FEdge>& InEdges);

		/** Removes every agent and restarts the random sequence. */
		void Reset(uint64_t Seed);

		void SetSettings(const FSimSettings& InSettings) { Settings = InSettings; }
		const FSimSettings& GetSettings() const { return Settings; }

		int32_t GetNodeCount() const { return static_cast<int32_t>(Nodes.size()); }
		int32_t GetDegree(int32_t Node) const;
		const FNode* GetNode(int32_t Node) const;

		/**
		 * Desired population (alive agents, including the ones handed to characters). Step() adds or removes
		 * agents at random places on the network to close the gap smoothly; bImmediate does it at once.
		 */
		void SetTarget(int32_t Count, bool bImmediate = false);
		int32_t GetTarget() const { return Target; }

		/** Agents are neither created nor removed within this circle (the area around the camera). Radius 0 turns it off. */
		void SetQuietZone(double X, double Y, double Radius);

		/** Advances every agent that is not controlled by a character by Dt seconds (clamped to 0-2 s). */
		void Step(double Dt);

		/**
		 * A gunshot or other alarm: agents within Radius panic for about PanicSeconds, turn away if they were
		 * walking towards it, run at PanicSpeedFactor times their speed and pick streets leading away from it.
		 * Returns how many agents were frightened.
		 */
		int32_t Flee(double X, double Y, double Radius);

		int32_t GetAliveCount() const { return AliveCount; }
		int32_t GetControlledCount() const { return ControlledCount; }

		/** Agents live in slots 0..GetSlotCount()-1; GetAgent returns null for an empty slot. */
		int32_t GetSlotCount() const { return static_cast<int32_t>(Agents.size()); }
		const FAgent* GetAgent(int32_t Index) const;

		/** Position on the pavement and walking direction of an agent (also valid while controlled: its last simulated pose). */
		bool GetPose(int32_t Index, FPose& Out) const;

		/** Hands an agent to a character: it stays in the population but the simulation stops moving it. */
		bool Detach(int32_t Index);

		/** Takes a controlled agent back, walking the given edge. Returns false (agent stays controlled) if the edge does not exist. */
		bool Attach(int32_t Index, const FHandBack& State);

		/** Removes an agent (e.g. its character died). */
		bool Kill(int32_t Index);

		/** Distance along From->To of the point on that edge closest to (X, Y). False if the edge does not exist. */
		bool ProjectOntoEdge(int32_t From, int32_t To, double X, double Y, double& OutDistance) const;

		/**
		 * Next junction for a walker who came from From and is now at Current: no turning back unless at a dead
		 * end, busier streets more likely. Random in [0, 1). NoNode if Current has no streets.
		 */
		int32_t PickNextNode(int32_t From, int32_t Current, double Random) const;

		/** Next junction for someone running away from (ThreatX, ThreatY): a street that takes them further away. */
		int32_t PickFleeNode(int32_t From, int32_t Current, double ThreatX, double ThreatY, double Random) const;

		/** Closest junction that has at least one street, or NoNode. Uses a uniform grid. */
		int32_t FindNearestNode(double X, double Y) const;

	private:
		struct FLink
		{
			int32_t To = NoNode;
			uint8_t Class = 1;
			double Length = 1.0;
		};

		int32_t PickNextLink(int32_t From, int32_t Current, double Random) const;
		int32_t PickFleeLink(int32_t From, int32_t Current, double ThreatX, double ThreatY, double Random) const;
		int32_t FindLink(int32_t From, int32_t To) const;
		void ComputePose(const FAgent& Agent, FPose& Out) const;
		void CurrentOffset(const FAgent& Agent, double& OutX, double& OutY) const;
		void EnterLink(FAgent& Agent, int32_t Link) const;
		void Advance(FAgent& Agent);
		void AdjustPopulation(double Dt, bool bImmediate);
		bool AddOne(bool bRespectQuietZone);
		bool RemoveOne(bool bRespectQuietZone);
		void FreeSlot(int32_t Index);
		bool InQuietZone(double X, double Y) const;
		void GridCell(double X, double Y, int32_t& OutCellX, int32_t& OutCellY) const;
		void BuildGrid();

		uint64_t NextRandom();
		double Random01();

		// Street graph, compressed: the links leaving node N are Links[FirstLink[N] .. FirstLink[N + 1]).
		std::vector<FNode> Nodes;
		std::vector<int32_t> FirstLink;
		std::vector<FLink> Links;
		std::vector<int32_t> LinkFrom;
		std::vector<double> SpawnCumulative; // running sum of length x class weight, for placing new agents

		// Uniform grid over the walkable nodes, for nearest-node queries.
		double GridMinX = 0.0;
		double GridMinY = 0.0;
		double CellSize = 5000.0;
		int32_t GridWidth = 0;
		int32_t GridHeight = 0;
		std::vector<int32_t> CellStart;
		std::vector<int32_t> CellNodes;

		std::vector<FAgent> Agents;
		std::vector<int32_t> FreeSlots;
		int32_t AliveCount = 0;
		int32_t ControlledCount = 0;
		int32_t Target = 0;

		double QuietX = 0.0;
		double QuietY = 0.0;
		double QuietRadius = 0.0;

		uint64_t RngState = 0;
		FSimSettings Settings;
	};
}
