// Tests Npc/CrowdSim: the district-wide pedestrian simulation behind ANpcManager.
#include "City/BsbReader.h"
#include "Npc/CrowdSim.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <limits>
#include <string>
#include <vector>

using namespace BudapestCrowd;

static int Failures = 0;
#define EXPECT(Cond, ...)                                  \
	do                                                     \
	{                                                      \
		if (!(Cond))                                       \
		{                                                  \
			std::printf("FAIL line %d: ", __LINE__);       \
			std::printf(__VA_ARGS__);                      \
			std::printf("\n");                             \
			++Failures;                                    \
		}                                                  \
	} while (0)

// Test-side random numbers (independent of the simulation's own generator).
static uint64_t TestRngState = 12345;
static double TestRandom()
{
	TestRngState ^= TestRngState << 13;
	TestRngState ^= TestRngState >> 7;
	TestRngState ^= TestRngState << 17;
	return static_cast<double>(TestRngState >> 11) * (1.0 / 9007199254740992.0);
}

static std::vector<uint8_t> Load(const std::string& Path)
{
	std::ifstream In(Path, std::ios::binary);
	return std::vector<uint8_t>((std::istreambuf_iterator<char>(In)), std::istreambuf_iterator<char>());
}

struct FTestGraph
{
	std::vector<FNode> Nodes;
	std::vector<FEdge> Edges;

	int32_t AddNode(double X, double Y)
	{
		FNode Node;
		Node.X = X;
		Node.Y = Y;
		Nodes.push_back(Node);
		return static_cast<int32_t>(Nodes.size()) - 1;
	}

	void AddEdge(int32_t A, int32_t B, uint8_t Class)
	{
		FEdge Edge;
		Edge.A = A;
		Edge.B = B;
		Edge.Class = Class;
		Edges.push_back(Edge);
	}
};

// Rows x Cols street grid, Spacing cm apart. Every third row is a main road, every fourth column a footpath.
static FTestGraph MakeGrid(int32_t Rows, int32_t Cols, double Spacing)
{
	FTestGraph Graph;
	for (int32_t Row = 0; Row < Rows; ++Row)
	{
		for (int32_t Col = 0; Col < Cols; ++Col)
		{
			Graph.AddNode(static_cast<double>(Row) * Spacing, static_cast<double>(Col) * Spacing);
		}
	}
	for (int32_t Row = 0; Row < Rows; ++Row)
	{
		for (int32_t Col = 0; Col < Cols; ++Col)
		{
			const int32_t Here = Row * Cols + Col;
			if (Col + 1 < Cols)
			{
				Graph.AddEdge(Here, Here + 1, static_cast<uint8_t>(Row % 3 == 0 ? 2 : 1));
			}
			if (Row + 1 < Rows)
			{
				Graph.AddEdge(Here, Here + Cols, static_cast<uint8_t>(Col % 4 == 0 ? 0 : 1));
			}
		}
	}
	return Graph;
}

// A grid plus the awkward cases real OSM data has: a dead-end spur, a duplicate edge, two junctions on the
// same spot, a self-loop, an edge to a missing node and an isolated node.
static FTestGraph MakeMessyGraph()
{
	FTestGraph Graph = MakeGrid(8, 8, 7000.0);
	const int32_t SpurEnd = Graph.AddNode(-4000.0, 0.0);
	Graph.AddEdge(0, SpurEnd, 0);
	Graph.AddEdge(1, 2, 2); // duplicate of a grid edge, different class
	const int32_t Twin = Graph.AddNode(Graph.Nodes[9].X, Graph.Nodes[9].Y);
	Graph.AddEdge(9, Twin, 1);
	Graph.AddEdge(Twin, 10, 1);
	Graph.AddEdge(5, 5, 1);      // self-loop: ignored
	Graph.AddEdge(5, 100000, 1); // missing node: ignored
	Graph.AddEdge(-3, 5, 1);     // negative index: ignored
	Graph.AddNode(1.0e6, 1.0e6); // isolated
	return Graph;
}

static bool Finite(double Value)
{
	return std::isfinite(Value);
}

// Every live agent must be on a real edge, inside it, with sane numbers and a pose next to the street.
static void CheckInvariants(const FSim& Sim, const FSimSettings& Settings, const char* Label)
{
	int32_t Alive = 0;
	int32_t Controlled = 0;
	int32_t Reported = 0;
	for (int32_t Index = 0; Index < Sim.GetSlotCount(); ++Index)
	{
		const FAgent* Agent = Sim.GetAgent(Index);
		if (Agent == nullptr)
		{
			continue;
		}
		++Alive;
		Controlled += Agent->bControlled ? 1 : 0;

		double Along = 0.0;
		const bool bOnEdge = Sim.ProjectOntoEdge(Agent->From, Agent->To, 0.0, 0.0, Along);
		const FNode* A = Sim.GetNode(Agent->From);
		const FNode* B = Sim.GetNode(Agent->To);
		bool bOk = bOnEdge && A != nullptr && B != nullptr;
		bOk = bOk && Finite(Agent->Distance) && Agent->Distance >= 0.0 && Agent->Distance <= Agent->Length;
		bOk = bOk && Agent->Length >= 1.0 && Finite(Agent->Length);
		bOk = bOk && Agent->Speed >= Settings.MinSpeed && Agent->Speed <= Settings.MaxSpeed;
		bOk = bOk && (Agent->Side == 1.0 || Agent->Side == -1.0);
		bOk = bOk && Agent->OffsetJitter >= 0.8 && Agent->OffsetJitter <= 1.2;
		bOk = bOk && Finite(Agent->PanicSeconds) && Agent->PanicSeconds >= 0.0;
		bOk = bOk && Agent->Seed >= 1u && Agent->Seed <= (1u << 30);
		if (bOk)
		{
			const double RealLength = std::hypot(B->X - A->X, B->Y - A->Y);
			bOk = std::fabs(std::max(1.0, RealLength) - Agent->Length) < 1e-6;
		}
		FPose Pose;
		if (bOk)
		{
			bOk = Sim.GetPose(Index, Pose) && Finite(Pose.X) && Finite(Pose.Y) && Finite(Pose.DirX) && Finite(Pose.DirY);
			bOk = bOk && std::fabs(std::hypot(Pose.DirX, Pose.DirY) - 1.0) < 1e-9;
		}
		if (bOk)
		{
			// The pose is the point on the centre line plus a pavement offset of at most 750 cm x 1.2.
			const double Along01 = Agent->Distance / Agent->Length;
			const double BaseX = A->X + (B->X - A->X) * Along01;
			const double BaseY = A->Y + (B->Y - A->Y) * Along01;
			bOk = std::hypot(Pose.X - BaseX, Pose.Y - BaseY) <= 750.0 * 1.2 + 1e-6;
		}
		if (!bOk && Reported < 5)
		{
			++Reported;
			EXPECT(false, "%s: agent %d broken (from %d to %d dist %f len %f speed %f side %f)", Label, Index,
				Agent->From, Agent->To, Agent->Distance, Agent->Length, Agent->Speed, Agent->Side);
		}
	}
	EXPECT(Alive == Sim.GetAliveCount(), "%s: alive count %d vs %d", Label, Alive, Sim.GetAliveCount());
	EXPECT(Controlled == Sim.GetControlledCount(), "%s: controlled count %d vs %d", Label, Controlled, Sim.GetControlledCount());
}

static bool SameAgent(const FAgent& A, const FAgent& B)
{
	return A.From == B.From && A.To == B.To && A.Distance == B.Distance && A.Length == B.Length && A.Speed == B.Speed &&
		A.Side == B.Side && A.OffsetJitter == B.OffsetJitter && A.PanicSeconds == B.PanicSeconds && A.ThreatX == B.ThreatX &&
		A.ThreatY == B.ThreatY && A.PrevOffsetX == B.PrevOffsetX && A.PrevOffsetY == B.PrevOffsetY && A.Seed == B.Seed &&
		A.Class == B.Class && A.bAlive == B.bAlive && A.bControlled == B.bControlled && A.bRoundingCorner == B.bRoundingCorner;
}

static bool SameState(const FSim& A, const FSim& B)
{
	if (A.GetSlotCount() != B.GetSlotCount() || A.GetAliveCount() != B.GetAliveCount())
	{
		return false;
	}
	for (int32_t Index = 0; Index < A.GetSlotCount(); ++Index)
	{
		const FAgent* AgentA = A.GetAgent(Index);
		const FAgent* AgentB = B.GetAgent(Index);
		if ((AgentA == nullptr) != (AgentB == nullptr) || (AgentA != nullptr && !SameAgent(*AgentA, *AgentB)))
		{
			return false;
		}
	}
	return true;
}

static double Distance2(double AX, double AY, double BX, double BY)
{
	return std::hypot(AX - BX, AY - BY);
}

static void TestDensity()
{
	EXPECT(std::fabs(DensityForHour(3.0f) - 0.02f) < 1e-6f, "3 am");
	EXPECT(std::fabs(DensityForHour(8.0f) - 0.90f) < 1e-6f, "8 am rush");
	EXPECT(std::fabs(DensityForHour(17.0f) - 1.00f) < 1e-6f, "17:00 peak");
	EXPECT(std::fabs(DensityForHour(7.5f) - 0.70f) < 1e-6f, "7:30 interpolates between 0.5 and 0.9: %f", static_cast<double>(DensityForHour(7.5f)));
	EXPECT(std::fabs(DensityForHour(24.0f) - DensityForHour(0.0f)) < 1e-6f, "24 wraps to 0");
	EXPECT(std::fabs(DensityForHour(-1.0f) - DensityForHour(23.0f)) < 1e-6f, "-1 wraps to 23");
	EXPECT(std::fabs(DensityForHour(47.5f) - DensityForHour(23.5f)) < 1e-6f, "47.5 wraps to 23.5");
	EXPECT(std::isfinite(DensityForHour(std::numeric_limits<float>::quiet_NaN())), "NaN hour");
	float Previous = DensityForHour(-48.0f);
	for (int32_t Step = 1; Step <= 96000; ++Step)
	{
		const float Hour = -48.0f + static_cast<float>(Step) * 0.001f;
		const float Density = DensityForHour(Hour);
		EXPECT(Density >= 0.0f && Density <= 1.0f, "density %f out of range at %f", static_cast<double>(Density), static_cast<double>(Hour));
		EXPECT(std::fabs(Density - Previous) < 0.01f, "density jumps at %f", static_cast<double>(Hour));
		Previous = Density;
	}
	EXPECT(PavementOffsetCm(0) == 60.0 && PavementOffsetCm(1) == 480.0 && PavementOffsetCm(2) == 750.0 && PavementOffsetCm(7) == 750.0, "pavement offsets");
	EXPECT(EdgeClassWeight(0) == 1.0 && EdgeClassWeight(1) == 2.0 && EdgeClassWeight(2) == 3.0 && EdgeClassWeight(9) == 3.0, "class weights");
}

static void TestGraphAndChoices()
{
	const FTestGraph Graph = MakeMessyGraph();
	FSim Sim;
	Sim.SetGraph(Graph.Nodes, Graph.Edges);
	EXPECT(Sim.GetNodeCount() == static_cast<int32_t>(Graph.Nodes.size()), "node count");
	EXPECT(Sim.GetDegree(0) == 3, "corner + spur degree %d", Sim.GetDegree(0)); // (0,1), (1,0) grid neighbours + spur
	EXPECT(Sim.GetDegree(5) == 3, "self-loop and bad edges ignored: degree %d", Sim.GetDegree(5));
	EXPECT(Sim.GetDegree(static_cast<int32_t>(Graph.Nodes.size()) - 1) == 0, "isolated node");
	EXPECT(Sim.GetDegree(-1) == 0 && Sim.GetDegree(1 << 30) == 0, "out-of-range degree");

	// Interior junction 9 (row 1, col 1) has neighbours 1, 17, 8, 10 and the twin node.
	const int32_t Junction = 3 * 8 + 3; // row 3, col 3: neighbours 19, 35, 26, 28
	int32_t Counts[64] = {};
	const int32_t Draws = 6000;
	for (int32_t Draw = 0; Draw < Draws; ++Draw)
	{
		const int32_t Next = Sim.PickNextNode(26, Junction, (static_cast<double>(Draw) + 0.5) / static_cast<double>(Draws));
		EXPECT(Next == 19 || Next == 35 || Next == 28, "junction: unexpected next %d", Next);
		if (Next >= 0 && Next < 64)
		{
			++Counts[Next];
		}
	}
	EXPECT(Counts[26] == 0, "turned back at a junction %d times", Counts[26]);
	// Row 3 is a main road (weight 3), column 3 is a quiet street (weight 2): 28 gets 3/7, 19 and 35 get 2/7 each.
	EXPECT(std::abs(Counts[28] - Draws * 3 / 7) <= 2, "main road share %d", Counts[28]);
	EXPECT(std::abs(Counts[19] - Draws * 2 / 7) <= 2 && std::abs(Counts[35] - Draws * 2 / 7) <= 2, "side street shares %d %d", Counts[19], Counts[35]);

	// No previous node: all four streets are possible.
	bool bSeen[4] = { false, false, false, false };
	for (int32_t Draw = 0; Draw < 100; ++Draw)
	{
		const int32_t Next = Sim.PickNextNode(NoNode, Junction, (static_cast<double>(Draw) + 0.5) / 100.0);
		bSeen[0] = bSeen[0] || Next == 19;
		bSeen[1] = bSeen[1] || Next == 35;
		bSeen[2] = bSeen[2] || Next == 26;
		bSeen[3] = bSeen[3] || Next == 28;
	}
	EXPECT(bSeen[0] && bSeen[1] && bSeen[2] && bSeen[3], "fresh walker can take any street");

	// Dead end: the only way is back.
	const int32_t SpurEnd = 64;
	EXPECT(Sim.PickNextNode(0, SpurEnd, 0.3) == 0, "dead end turns back");
	EXPECT(Sim.PickNextNode(NoNode, SpurEnd, 0.9) == 0, "dead end without history");
	EXPECT(Sim.PickNextNode(0, static_cast<int32_t>(Graph.Nodes.size()) - 1, 0.5) == NoNode, "isolated node has no next");
	EXPECT(Sim.PickNextNode(0, -5, 0.5) == NoNode && Sim.PickNextNode(0, 1 << 30, 0.5) == NoNode, "invalid node");
	EXPECT(Sim.PickNextNode(26, Junction, std::numeric_limits<double>::quiet_NaN()) != NoNode, "NaN random still picks");

	// Fleeing from the west side of the junction: always a street that increases the distance.
	const FNode* Here = Sim.GetNode(Junction);
	const double ThreatX = Here->X - 100.0;
	const double ThreatY = Here->Y - 2500.0;
	for (int32_t Draw = 0; Draw < 200; ++Draw)
	{
		const int32_t Next = Sim.PickFleeNode(19, Junction, ThreatX, ThreatY, (static_cast<double>(Draw) + 0.5) / 200.0);
		const FNode* There = Sim.GetNode(Next);
		EXPECT(There != nullptr && Distance2(There->X, There->Y, ThreatX, ThreatY) > Distance2(Here->X, Here->Y, ThreatX, ThreatY),
			"flee choice %d moves towards the threat", Next);
	}
	// Cornered at the end of the spur with the threat beyond it: the least bad street (the only one).
	EXPECT(Sim.PickFleeNode(0, SpurEnd, -100000.0, 0.0, 0.5) == 0, "cornered flee");
	EXPECT(Sim.PickFleeNode(0, -1, 0.0, 0.0, 0.5) == NoNode, "flee from invalid node");
}

static void TestNearestNode()
{
	FTestGraph Graph = MakeMessyGraph();
	for (int32_t Extra = 0; Extra < 300; ++Extra)
	{
		const int32_t A = Graph.AddNode(TestRandom() * 60000.0 - 5000.0, TestRandom() * 60000.0 - 5000.0);
		Graph.AddEdge(A, static_cast<int32_t>(TestRandom() * 63.0), 1);
	}
	FSim Sim;
	Sim.SetGraph(Graph.Nodes, Graph.Edges);

	int32_t Mismatches = 0;
	for (int32_t Query = 0; Query < 4000; ++Query)
	{
		const double Spread = Query < 3000 ? 80000.0 : 4.0e7;
		const double X = TestRandom() * Spread - Spread * 0.4;
		const double Y = TestRandom() * Spread - Spread * 0.4;
		double BestBrute = std::numeric_limits<double>::max();
		for (int32_t Node = 0; Node < Sim.GetNodeCount(); ++Node)
		{
			if (Sim.GetDegree(Node) > 0)
			{
				BestBrute = std::min(BestBrute, Distance2(Graph.Nodes[static_cast<size_t>(Node)].X, Graph.Nodes[static_cast<size_t>(Node)].Y, X, Y));
			}
		}
		const int32_t Found = Sim.FindNearestNode(X, Y);
		const FNode* Node = Sim.GetNode(Found);
		if (Node == nullptr || Sim.GetDegree(Found) == 0 || std::fabs(Distance2(Node->X, Node->Y, X, Y) - BestBrute) > 1e-6)
		{
			++Mismatches;
		}
	}
	EXPECT(Mismatches == 0, "nearest node differs from brute force in %d queries", Mismatches);
	EXPECT(Sim.FindNearestNode(1.0e6, 1.0e6) != static_cast<int32_t>(Graph.Nodes.size()) - 301, "isolated node is never the answer");
	EXPECT(Sim.FindNearestNode(std::numeric_limits<double>::quiet_NaN(), 0.0) == NoNode, "NaN query");
	EXPECT(Sim.FindNearestNode(1.0e300, -1.0e300) != NoNode, "huge query still answers");

	// A network spanning a huge area uses coarser cells but stays exact.
	FTestGraph Wide;
	for (int32_t Node = 0; Node < 200; ++Node)
	{
		Wide.AddNode(TestRandom() * 1.0e9, TestRandom() * 1.0e9);
		if (Node > 0)
		{
			Wide.AddEdge(Node - 1, Node, 1);
		}
	}
	FSim WideSim;
	WideSim.SetGraph(Wide.Nodes, Wide.Edges);
	int32_t WideMismatches = 0;
	for (int32_t Query = 0; Query < 500; ++Query)
	{
		const double X = TestRandom() * 1.2e9 - 1.0e8;
		const double Y = TestRandom() * 1.2e9 - 1.0e8;
		double BestBrute = std::numeric_limits<double>::max();
		for (const FNode& Node : Wide.Nodes)
		{
			BestBrute = std::min(BestBrute, Distance2(Node.X, Node.Y, X, Y));
		}
		const FNode* Node = WideSim.GetNode(WideSim.FindNearestNode(X, Y));
		if (Node == nullptr || std::fabs(Distance2(Node->X, Node->Y, X, Y) - BestBrute) > 1e-3)
		{
			++WideMismatches;
		}
	}
	EXPECT(WideMismatches == 0, "wide network: %d mismatches", WideMismatches);

	FSim Empty;
	EXPECT(Empty.FindNearestNode(0.0, 0.0) == NoNode, "empty graph has no nearest node");
}

static void TestPopulation()
{
	const FTestGraph Graph = MakeGrid(20, 20, 6000.0);
	FSim Sim;
	Sim.Reset(7);
	Sim.SetGraph(Graph.Nodes, Graph.Edges);
	const FSimSettings Settings = Sim.GetSettings();

	Sim.SetTarget(1000, true);
	EXPECT(Sim.GetAliveCount() == 1000, "immediate fill: %d", Sim.GetAliveCount());
	CheckInvariants(Sim, Settings, "after fill");

	// Down to 400: smoothly, never below the target, converging.
	Sim.SetTarget(400);
	int32_t Previous = Sim.GetAliveCount();
	int32_t Steps = 0;
	bool bSmooth = true;
	while (Sim.GetAliveCount() != 400 && Steps < 1000)
	{
		Sim.Step(0.1);
		++Steps;
		const int32_t Now = Sim.GetAliveCount();
		bSmooth = bSmooth && Now <= Previous && Now >= 400 && Previous - Now <= 31;
		Previous = Now;
	}
	EXPECT(Sim.GetAliveCount() == 400, "population did not converge down: %d", Sim.GetAliveCount());
	EXPECT(bSmooth, "population shrank too abruptly or overshot");
	EXPECT(Steps > 20 && Steps < 400, "convergence took %d steps", Steps);

	// Back up to 1500.
	Sim.SetTarget(1500);
	Steps = 0;
	Previous = Sim.GetAliveCount();
	bSmooth = true;
	while (Sim.GetAliveCount() != 1500 && Steps < 1000)
	{
		Sim.Step(0.1);
		++Steps;
		const int32_t Now = Sim.GetAliveCount();
		bSmooth = bSmooth && Now >= Previous && Now <= 1500;
		Previous = Now;
	}
	EXPECT(Sim.GetAliveCount() == 1500, "population did not converge up: %d", Sim.GetAliveCount());
	EXPECT(bSmooth, "population grew unevenly or overshot");
	CheckInvariants(Sim, Settings, "after growth");

	// Following the day: the population tracks DensityForHour x peak as the clock runs.
	int32_t WorstGap = 0;
	for (int32_t Step = 0; Step < 2400; ++Step)
	{
		const float Hour = static_cast<float>(Step) * 0.01f; // a whole day, 36 game seconds per step
		Sim.SetTarget(static_cast<int32_t>(std::lround(2500.0 * static_cast<double>(DensityForHour(Hour)))));
		Sim.Step(0.5);
		if (Step > 100)
		{
			WorstGap = std::max(WorstGap, std::abs(Sim.GetAliveCount() - Sim.GetTarget()));
		}
	}
	EXPECT(WorstGap < 120, "population lags the daily curve by up to %d", WorstGap);

	// Quiet zone: nobody appears or disappears near the camera.
	FSim Quiet;
	Quiet.SetGraph(Graph.Nodes, Graph.Edges);
	FSimSettings Instant = Quiet.GetSettings();
	Instant.PopulationTimeConstant = 1e-3;
	Quiet.SetSettings(Instant);
	const double CenterX = 9.5 * 6000.0;
	const double CenterY = 9.5 * 6000.0;
	const double Radius = 30000.0;
	Quiet.SetQuietZone(CenterX, CenterY, Radius);
	Quiet.SetTarget(800);
	Quiet.Step(1e-3); // closes the whole gap at once (time constant 1 ms); walkers move only 0.16 cm
	int32_t Inside = 0;
	for (int32_t Index = 0; Index < Quiet.GetSlotCount(); ++Index)
	{
		FPose Pose;
		if (Quiet.GetPose(Index, Pose) && Distance2(Pose.X, Pose.Y, CenterX, CenterY) < Radius - 1.0)
		{
			++Inside;
		}
	}
	EXPECT(Quiet.GetAliveCount() > 500, "quiet zone: only %d spawned outside", Quiet.GetAliveCount());
	EXPECT(Inside == 0, "quiet zone: %d agents spawned inside", Inside);

	// The whole network quiet: no change at all, except an immediate fill (game start) which ignores it.
	Quiet.SetQuietZone(CenterX, CenterY, 1.0e7);
	const int32_t Before = Quiet.GetAliveCount();
	Quiet.SetTarget(0);
	for (int32_t Step = 0; Step < 50; ++Step)
	{
		Quiet.Step(0.1);
	}
	EXPECT(Quiet.GetAliveCount() == Before, "removal inside the quiet zone: %d -> %d", Before, Quiet.GetAliveCount());
	Quiet.SetTarget(1200, true);
	EXPECT(Quiet.GetAliveCount() == 1200, "immediate fill ignores the quiet zone: %d", Quiet.GetAliveCount());
	Quiet.SetQuietZone(0.0, 0.0, 0.0);
	Quiet.SetTarget(-5, true);
	EXPECT(Quiet.GetAliveCount() == 0 && Quiet.GetTarget() == 0, "negative target clamps to zero");
}

static void TestSteppingInvariants()
{
	const FTestGraph Graph = MakeMessyGraph();
	FSim Sim;
	Sim.Reset(99);
	Sim.SetGraph(Graph.Nodes, Graph.Edges);
	const FSimSettings Settings = Sim.GetSettings();
	Sim.SetTarget(2000, true);

	const double Nasty[] = { 0.0, -1.0, std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(), 100.0, 1e-9 };
	for (int32_t Step = 0; Step < 3000; ++Step)
	{
		double Dt = 0.016 + TestRandom() * 0.3;
		if (Step % 97 == 0)
		{
			Dt = Nasty[(Step / 97) % 6];
		}
		Sim.Step(Dt);
		if (Step % 50 == 0)
		{
			Sim.Flee(TestRandom() * 50000.0, TestRandom() * 50000.0, 1000.0 + TestRandom() * 8000.0);
		}
		if (Step % 400 == 0)
		{
			Sim.SetTarget(static_cast<int32_t>(TestRandom() * 3000.0));
		}
		if (Step % 100 == 0)
		{
			CheckInvariants(Sim, Settings, "messy graph stepping");
		}
	}
	CheckInvariants(Sim, Settings, "messy graph end");

	// Junction crossings are continuous: no agent ever jumps, corners included (clean grid, small steps).
	const FTestGraph Grid = MakeGrid(10, 10, 8000.0);
	FSim Smooth;
	Smooth.SetGraph(Grid.Nodes, Grid.Edges);
	Smooth.SetTarget(300, true);
	std::vector<FPose> Last(static_cast<size_t>(Smooth.GetSlotCount()));
	for (int32_t Index = 0; Index < Smooth.GetSlotCount(); ++Index)
	{
		Smooth.GetPose(Index, Last[static_cast<size_t>(Index)]);
	}
	double WorstJump = 0.0;
	for (int32_t Step = 0; Step < 6000; ++Step)
	{
		Smooth.Step(0.01);
		for (int32_t Index = 0; Index < Smooth.GetSlotCount(); ++Index)
		{
			FPose Pose;
			Smooth.GetPose(Index, Pose);
			WorstJump = std::max(WorstJump, Distance2(Pose.X, Pose.Y, Last[static_cast<size_t>(Index)].X, Last[static_cast<size_t>(Index)].Y));
			Last[static_cast<size_t>(Index)] = Pose;
		}
	}
	// 1.6 cm of walking per step plus the sideways swing round a corner (at most ~5 cm per step).
	EXPECT(WorstJump < 10.0, "an agent jumped %f cm in one 10 ms step", WorstJump);

	// A single street with two dead ends: walkers bounce between them on the SAME pavement.
	FTestGraph Line;
	Line.AddNode(0.0, 0.0);
	Line.AddNode(10000.0, 0.0);
	Line.AddEdge(0, 1, 1);
	FSim Bounce;
	Bounce.SetGraph(Line.Nodes, Line.Edges);
	Bounce.SetTarget(50, true);
	std::vector<double> SideOfStreet(static_cast<size_t>(Bounce.GetSlotCount()));
	for (int32_t Index = 0; Index < Bounce.GetSlotCount(); ++Index)
	{
		FPose Pose;
		Bounce.GetPose(Index, Pose);
		SideOfStreet[static_cast<size_t>(Index)] = Pose.Y;
	}
	int32_t Crossings = 0;
	for (int32_t Step = 0; Step < 4000; ++Step)
	{
		Bounce.Step(0.1);
		for (int32_t Index = 0; Index < Bounce.GetSlotCount(); ++Index)
		{
			FPose Pose;
			Bounce.GetPose(Index, Pose);
			if (Pose.Y * SideOfStreet[static_cast<size_t>(Index)] <= 0.0 || std::fabs(Pose.Y) < 0.8 * 480.0 - 1e-6)
			{
				++Crossings;
			}
		}
	}
	EXPECT(Crossings == 0, "walkers crossed the street at dead ends %d times", Crossings);
	CheckInvariants(Bounce, Bounce.GetSettings(), "bouncing");

	// Junctions on the same spot (zero-length edge) and degenerate graphs.
	FTestGraph Twin;
	Twin.AddNode(0.0, 0.0);
	Twin.AddNode(0.0, 0.0);
	Twin.AddNode(5000.0, 0.0);
	Twin.AddEdge(0, 1, 1);
	Twin.AddEdge(1, 2, 2);
	FSim TwinSim;
	TwinSim.SetGraph(Twin.Nodes, Twin.Edges);
	TwinSim.SetTarget(40, true);
	for (int32_t Step = 0; Step < 2000; ++Step)
	{
		TwinSim.Step(0.25);
	}
	CheckInvariants(TwinSim, TwinSim.GetSettings(), "zero-length edge");

	FTestGraph Loops;
	Loops.AddNode(0.0, 0.0);
	Loops.AddNode(std::numeric_limits<double>::quiet_NaN(), 0.0);
	Loops.AddEdge(0, 0, 1);
	Loops.AddEdge(0, 1, 1); // touches a NaN node: ignored
	FSim LoopSim;
	LoopSim.SetGraph(Loops.Nodes, Loops.Edges);
	LoopSim.SetTarget(10, true);
	LoopSim.Step(0.1);
	EXPECT(LoopSim.GetAliveCount() == 0, "agents on a graph without streets");
	EXPECT(LoopSim.Flee(0.0, 0.0, 100.0) == 0 && LoopSim.FindNearestNode(0.0, 0.0) == NoNode, "graph without streets");

	FSim Empty;
	Empty.SetTarget(100, true);
	Empty.Step(0.1);
	FPose Pose;
	EXPECT(Empty.GetAliveCount() == 0 && !Empty.GetPose(0, Pose) && Empty.PickNextNode(NoNode, 0, 0.5) == NoNode, "empty simulation");
	EXPECT(!Empty.Detach(0) && !Empty.Kill(0) && Empty.GetAgent(0) == nullptr, "empty simulation slots");
}

static void TestFlee()
{
	const FTestGraph Graph = MakeGrid(25, 25, 5000.0);
	FSim Sim;
	Sim.Reset(2024);
	Sim.SetGraph(Graph.Nodes, Graph.Edges);
	Sim.SetTarget(3000, true);
	for (int32_t Step = 0; Step < 200; ++Step)
	{
		Sim.Step(0.1);
	}

	const double ShotX = 12.3 * 5000.0;
	const double ShotY = 11.8 * 5000.0;
	const double Radius = 9000.0;

	FSim Control = Sim; // the same crowd, nobody hears the shot
	std::vector<int32_t> Near;
	std::vector<double> Before;
	for (int32_t Index = 0; Index < Sim.GetSlotCount(); ++Index)
	{
		FPose Pose;
		if (Sim.GetPose(Index, Pose))
		{
			const double Distance = Distance2(Pose.X, Pose.Y, ShotX, ShotY);
			if (Distance <= Radius)
			{
				Near.push_back(Index);
				Before.push_back(Distance);
			}
		}
	}
	const int32_t Frightened = Sim.Flee(ShotX, ShotY, Radius);
	EXPECT(Frightened == static_cast<int32_t>(Near.size()) && Frightened > 20, "frightened %d, expected %zu (> 20)", Frightened, Near.size());

	int32_t WronglyCalm = 0;
	int32_t WronglyScared = 0;
	for (int32_t Index = 0; Index < Sim.GetSlotCount(); ++Index)
	{
		const FAgent* Agent = Sim.GetAgent(Index);
		if (Agent == nullptr)
		{
			continue;
		}
		bool bNear = false;
		for (const int32_t Candidate : Near)
		{
			bNear = bNear || Candidate == Index;
		}
		WronglyCalm += (bNear && !(Agent->PanicSeconds >= 17.0 && Agent->PanicSeconds <= 23.0)) ? 1 : 0;
		WronglyScared += (!bNear && Agent->PanicSeconds > 0.0) ? 1 : 0;
	}
	EXPECT(WronglyCalm == 0 && WronglyScared == 0, "panic flags: %d calm near the shot, %d scared far away", WronglyCalm, WronglyScared);

	for (int32_t Step = 0; Step < 100; ++Step)
	{
		Sim.Step(0.1);
		Control.Step(0.1);
	}

	double FleeGain = 0.0;
	double ControlGain = 0.0;
	int32_t FartherCount = 0;
	for (size_t Item = 0; Item < Near.size(); ++Item)
	{
		FPose Fled;
		FPose Calm;
		Sim.GetPose(Near[Item], Fled);
		Control.GetPose(Near[Item], Calm);
		const double FledDistance = Distance2(Fled.X, Fled.Y, ShotX, ShotY);
		FleeGain += FledDistance - Before[Item];
		ControlGain += Distance2(Calm.X, Calm.Y, ShotX, ShotY) - Before[Item];
		FartherCount += FledDistance > Before[Item] ? 1 : 0;
	}
	FleeGain /= static_cast<double>(Near.size());
	ControlGain /= static_cast<double>(Near.size());
	std::printf("  flee: %zu frightened, mean distance gain after 10 s %.0f cm (walking on: %.0f cm), %d farther\n", Near.size(), FleeGain, ControlGain, FartherCount);
	EXPECT(FleeGain > 2500.0, "fleeing gains only %f cm in 10 s", FleeGain);
	EXPECT(FleeGain > ControlGain + 2000.0, "fleeing (%f) is not clearly better than walking on (%f)", FleeGain, ControlGain);
	EXPECT(FartherCount * 10 >= static_cast<int32_t>(Near.size()) * 9, "only %d of %zu got farther away", FartherCount, Near.size());

	// Panic wears off.
	for (int32_t Step = 0; Step < 200; ++Step)
	{
		Sim.Step(0.1);
	}
	int32_t StillPanicking = 0;
	for (int32_t Index = 0; Index < Sim.GetSlotCount(); ++Index)
	{
		const FAgent* Agent = Sim.GetAgent(Index);
		StillPanicking += (Agent != nullptr && Agent->PanicSeconds > 0.0) ? 1 : 0;
	}
	EXPECT(StillPanicking == 0, "%d agents still panicking after 30 s", StillPanicking);
	CheckInvariants(Sim, Sim.GetSettings(), "after flee");

	EXPECT(Sim.Flee(ShotX, ShotY, 0.0) == 0 && Sim.Flee(ShotX, ShotY, -5.0) == 0, "zero radius frightens nobody");
	EXPECT(Sim.Flee(std::numeric_limits<double>::quiet_NaN(), ShotY, 5000.0) == 0, "NaN shot frightens nobody");
}

static void TestDeterminism()
{
	const FTestGraph Graph = MakeMessyGraph();
	auto Run = [&Graph](uint64_t Seed)
	{
		FSim Sim;
		Sim.Reset(Seed);
		Sim.SetGraph(Graph.Nodes, Graph.Edges);
		Sim.SetTarget(800, true);
		for (int32_t Step = 0; Step < 500; ++Step)
		{
			Sim.Step(0.05 + 0.001 * static_cast<double>(Step % 17));
			if (Step == 100)
			{
				Sim.Flee(20000.0, 20000.0, 9000.0);
				Sim.Detach(3);
				Sim.Detach(10);
			}
			if (Step == 200)
			{
				Sim.SetTarget(300);
				Sim.Kill(10);
			}
			if (Step == 300)
			{
				FHandBack Back;
				Back.From = 0;
				Back.To = 1;
				Back.Distance = 1234.0;
				Sim.Attach(3, Back);
			}
		}
		return Sim;
	};
	const FSim First = Run(42);
	const FSim Second = Run(42);
	const FSim Other = Run(43);
	EXPECT(SameState(First, Second), "same seed, same calls, different crowd");
	EXPECT(!SameState(First, Other), "different seeds gave the same crowd");
}

static void TestHandOff()
{
	const FTestGraph Graph = MakeGrid(12, 12, 6000.0);
	FSim Sim;
	Sim.Reset(5);
	Sim.SetGraph(Graph.Nodes, Graph.Edges);
	Sim.SetTarget(500, true);
	for (int32_t Step = 0; Step < 30; ++Step)
	{
		Sim.Step(0.1);
	}

	// An agent that is not rounding a corner, so its pose is exactly centre line + pavement offset.
	int32_t Chosen = NoNode;
	for (int32_t Index = 0; Index < Sim.GetSlotCount() && Chosen == NoNode; ++Index)
	{
		const FAgent* Agent = Sim.GetAgent(Index);
		if (Agent != nullptr && (!Agent->bRoundingCorner || Agent->Distance > 700.0) && Agent->Distance > 100.0)
		{
			Chosen = Index;
		}
	}
	EXPECT(Chosen != NoNode, "no suitable agent");
	if (Chosen == NoNode)
	{
		return;
	}

	FPose Start;
	Sim.GetPose(Chosen, Start);
	EXPECT(Sim.Detach(Chosen) && !Sim.Detach(Chosen), "detach once");
	const FAgent Snapshot = *Sim.GetAgent(Chosen);
	EXPECT(Sim.GetControlledCount() == 1 && Sim.GetAliveCount() == 500, "detached agent still counts");

	for (int32_t Step = 0; Step < 100; ++Step)
	{
		Sim.Step(0.1);
	}
	EXPECT(SameAgent(*Sim.GetAgent(Chosen), Snapshot), "the simulation moved a controlled agent");
	EXPECT(Sim.Flee(Start.X, Start.Y, 100000.0) > 0 && Sim.GetAgent(Chosen)->PanicSeconds == 0.0, "flee touched a controlled agent");

	// Shrinking the crowd never removes an agent a character is using.
	Sim.SetTarget(0);
	for (int32_t Step = 0; Step < 600; ++Step)
	{
		Sim.Step(0.1);
	}
	EXPECT(Sim.GetAliveCount() == 1 && Sim.GetAgent(Chosen) != nullptr, "controlled agent removed (alive %d)", Sim.GetAliveCount());

	// Hand back at the same place: projecting the pose onto its edge and attaching reproduces it.
	double Along = 0.0;
	EXPECT(Sim.ProjectOntoEdge(Snapshot.From, Snapshot.To, Start.X, Start.Y, Along), "project onto own edge");
	EXPECT(std::fabs(Along - Snapshot.Distance) < 1e-6, "projection %f vs distance %f", Along, Snapshot.Distance);
	FHandBack Back;
	Back.From = Snapshot.From;
	Back.To = Snapshot.To;
	Back.Distance = Along;
	Back.Side = Snapshot.Side;
	EXPECT(Sim.Attach(Chosen, Back), "attach");
	FPose After;
	Sim.GetPose(Chosen, After);
	EXPECT(Distance2(After.X, After.Y, Start.X, Start.Y) < 1e-6, "round trip moved the agent by %f cm", Distance2(After.X, After.Y, Start.X, Start.Y));
	EXPECT(Sim.GetControlledCount() == 0 && !Sim.Attach(Chosen, Back), "attach only once");

	// Hand back somewhere else, panicking: the agent runs at three times its speed away from the threat.
	EXPECT(Sim.Detach(Chosen), "detach again");
	FHandBack Bad = Back;
	Bad.To = Snapshot.From; // not an edge
	EXPECT(!Sim.Attach(Chosen, Bad) && Sim.GetControlledCount() == 1, "attach to a non-edge must fail and keep control");
	FHandBack Panicked;
	Panicked.From = 0;
	Panicked.To = 1; // along +Y, 6000 cm
	Panicked.Distance = std::numeric_limits<double>::quiet_NaN();
	Panicked.Side = -1.0;
	Panicked.PanicSeconds = 5.0;
	Panicked.ThreatX = 0.0;
	Panicked.ThreatY = -3000.0;
	EXPECT(Sim.Attach(Chosen, Panicked), "attach panicked");
	const FAgent* Agent = Sim.GetAgent(Chosen);
	EXPECT(Agent->Distance == 0.0 && Agent->Side == -1.0 && Agent->PanicSeconds == 5.0, "attached state");
	Sim.SetTarget(1); // (target 0 would send it home on the next step)
	Sim.Step(1.0);
	EXPECT(std::fabs(Agent->Distance - 3.0 * Snapshot.Speed) < 1e-6, "panicked agent ran %f cm in 1 s (speed %f)", Agent->Distance, Snapshot.Speed);
	EXPECT(Agent->Seed == Snapshot.Seed && Agent->Speed == Snapshot.Speed, "look seed and speed survive the round trip");

	EXPECT(Sim.Kill(Chosen) && !Sim.Kill(Chosen) && Sim.GetAliveCount() == 0, "kill");
	EXPECT(!Sim.Detach(Chosen) && !Sim.Attach(Chosen, Back) && Sim.GetAgent(Chosen) == nullptr, "dead slot");
	CheckInvariants(Sim, Sim.GetSettings(), "after hand-off tests");

	// Freed slots are reused.
	const int32_t Slots = Sim.GetSlotCount();
	Sim.SetTarget(Slots, true);
	EXPECT(Sim.GetSlotCount() == Slots && Sim.GetAliveCount() == Slots, "slots reused: %d slots for %d agents", Sim.GetSlotCount(), Sim.GetAliveCount());
}

static void TestBakedFixture(const std::string& Dir)
{
	// The real baked format (Tools/Districts/bake_district.py), projected like BudapestGeo::LatLonToWorld.
	const std::vector<uint8_t> Bytes = Load(Dir + "/sample_paths.bsb");
	Bsb::FPaths Paths;
	EXPECT(!Bytes.empty() && Bsb::ReadPaths(Bytes.data(), Bytes.size(), Paths), "cannot read paths fixture");
	if (Paths.Nodes.empty())
	{
		return;
	}

	const double Pi = 3.14159265358979323846;
	const double OriginLat = 47.4925;
	const double OriginLon = 19.0800;
	std::vector<FNode> Nodes;
	for (const Bsb::FPoint& Point : Paths.Nodes)
	{
		FNode Node;
		Node.X = (Point.Latitude - OriginLat) * Pi / 180.0 * 6371008.8 * 100.0;
		Node.Y = (Point.Longitude - OriginLon) * Pi / 180.0 * 6371008.8 * std::cos(OriginLat * Pi / 180.0) * 100.0;
		Nodes.push_back(Node);
	}
	std::vector<FEdge> Edges;
	for (const Bsb::FPathEdge& PathEdge : Paths.Edges)
	{
		FEdge Edge;
		Edge.A = static_cast<int32_t>(PathEdge.NodeA);
		Edge.B = static_cast<int32_t>(PathEdge.NodeB);
		Edge.Class = PathEdge.Class;
		Edges.push_back(Edge);
	}

	FSim Sim;
	Sim.SetGraph(Nodes, Edges);
	for (int32_t Node = 0; Node < Sim.GetNodeCount(); ++Node)
	{
		if (Sim.GetDegree(Node) > 0)
		{
			const int32_t Found = Sim.FindNearestNode(Nodes[static_cast<size_t>(Node)].X + 10.0, Nodes[static_cast<size_t>(Node)].Y - 10.0);
			const FNode* Hit = Sim.GetNode(Found);
			EXPECT(Hit != nullptr && Distance2(Hit->X, Hit->Y, Nodes[static_cast<size_t>(Node)].X, Nodes[static_cast<size_t>(Node)].Y) < 1e-6, "fixture node %d not found", Node);
		}
	}
	Sim.SetTarget(200, true);
	EXPECT(Sim.GetAliveCount() == 200, "fixture fill %d", Sim.GetAliveCount());
	for (int32_t Step = 0; Step < 1000; ++Step)
	{
		Sim.Step(0.1);
		if (Step == 500)
		{
			EXPECT(Sim.Flee(0.0, 0.0, 5000.0) > 0, "nobody near the fixture centre");
		}
	}
	CheckInvariants(Sim, Sim.GetSettings(), "baked fixture");
}

static void TestPerformance()
{
	const FTestGraph Graph = MakeGrid(60, 60, 5000.0); // 3 km x 3 km, about the VIII. district
	FSim Sim;
	Sim.SetGraph(Graph.Nodes, Graph.Edges);
	Sim.SetTarget(5000, true);

	const auto Start = std::chrono::steady_clock::now();
	double Checksum = 0.0;
	for (int32_t Step = 0; Step < 1000; ++Step)
	{
		Sim.Step(0.1);
		if (Step % 100 == 0)
		{
			Sim.Flee(150000.0, 150000.0, 5000.0);
		}
	}
	for (int32_t Index = 0; Index < Sim.GetSlotCount(); ++Index)
	{
		FPose Pose;
		if (Sim.GetPose(Index, Pose))
		{
			Checksum += Pose.X + Pose.Y;
		}
	}
	const double Seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - Start).count();
	std::printf("  performance: 5000 agents x 1000 steps in %.3f s (%.1f ns per agent-step)\n", Seconds, Seconds * 1e9 / 5.0e6);
	EXPECT(std::isfinite(Checksum), "checksum");
	EXPECT(Seconds < 4.0, "5000 agents x 1000 steps took %f s", Seconds);
	CheckInvariants(Sim, Sim.GetSettings(), "performance run");
}

int main(int argc, char** argv)
{
	const std::string Dir = argc > 1 ? argv[1] : "../Districts/fixtures";

	TestDensity();
	TestGraphAndChoices();
	TestNearestNode();
	TestPopulation();
	TestSteppingInvariants();
	TestFlee();
	TestDeterminism();
	TestHandOff();
	TestBakedFixture(Dir);
	TestPerformance();

	if (Failures != 0)
	{
		std::printf("crowd: %d FAILURE(S)\n", Failures);
		return 1;
	}
	std::printf("crowd: all checks passed\n");
	return 0;
}
