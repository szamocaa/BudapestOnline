// The static transit network of the district (BKK GTFS lines, their shapes and stops, baked by
// Tools/Transit/bake_gtfs.py) and the geometry the game does with it: reading the file, route types,
// snapping vehicles onto their line, moving them along it, track and route ribbon meshes, sign text.
// Plain C++ (no Unreal types) so it can be tested outside the engine (Tools/CoreTests/transit_static_test.cpp).
//
// File layout (little-endian; str = u16 byte length + UTF-8 bytes):
//
//   char[4] "BSBT", u32 version (= 1)
//   u32 routeCount
//     per route: str id, str shortName, u16 routeType, u8[3] colour RGB, u8[3] text colour RGB
//   u32 shapeCount
//     per shape: u32 routeIndex, u32 pointCount (>= 2), pointCount x (f64 lat, f64 lon)
//   u32 stopCount
//     per stop: str id, str name, f64 lat, f64 lon, u16 routeCount, routeCount x u32 routeIndex
//
// Geometry uses the project's world frame (X = north, Y = east, see GeoProjection.h) in any
// consistent unit; the game uses centimetres, and the defaults below assume them. Yaw is a compass
// angle in degrees: 0 = +X (north), 90 = +Y (east), which is also Unreal's actor yaw in this frame.
#pragma once

#include "City/BuildingMesher.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace GtfsStatic
{
	// --- File -------------------------------------------------------------------------------

	// Same order and values as ETransitMode in TransitTypes.h (TransitNetwork.cpp checks it).
	enum class EMode : uint8_t
	{
		Unknown,
		Tram,
		Metro,
		Bus,
		Trolleybus,
		SuburbanRail,
		Ferry
	};

	// GTFS route_type, basic (0 tram, 1 metro, 2 rail, 3 bus, 4 ferry, 11 trolleybus) or extended
	// (900-906 tram, 400-404 metro, 100-117 rail, 200-209 and 700-716 bus, 800 trolleybus, 1000/1200 ferry).
	EMode ModeForRouteType(int RouteType);

	struct FRgb
	{
		uint8_t R = 0;
		uint8_t G = 0;
		uint8_t B = 0;
	};

	struct FRoute
	{
		std::string Id;
		std::string ShortName;
		uint16_t RouteType = 0;
		FRgb Color;
		FRgb TextColor;
	};

	struct FLatLon
	{
		double Latitude = 0.0;
		double Longitude = 0.0;
	};

	struct FShape
	{
		uint32_t RouteIndex = 0;
		std::vector<FLatLon> Points; // at least two
	};

	struct FStop
	{
		std::string Id;
		std::string Name;
		FLatLon Position;
		std::vector<uint32_t> RouteIndices; // routes that call here (empty if the baker did not read stop_times.txt)
	};

	struct FNetwork
	{
		std::vector<FRoute> Routes;
		std::vector<FShape> Shapes;
		std::vector<FStop> Stops;
	};

	// Returns false (Out then holds nothing useful) on a bad magic or version, truncation, trailing
	// bytes, a shape with fewer than two points, or a route index that points past the routes.
	bool ReadNetwork(const uint8_t* Data, size_t Size, FNetwork& Out);

	// --- Angles -----------------------------------------------------------------------------

	struct FVec2
	{
		double X = 0.0;
		double Y = 0.0;
	};

	// Compass yaw of a direction, in [0, 360). 0 for a zero vector.
	double YawOf(double DirectionX, double DirectionY);

	// Absolute difference between two yaws, 0..180.
	double YawDifference(double YawA, double YawB);

	// Whichever of SegmentYaw and SegmentYaw + 180 is closer to ReferenceYaw, in [0, 360): a line has
	// two directions, and a vehicle keeps the one it was already facing (no sudden half turns).
	double ContinuousYaw(double SegmentYaw, double ReferenceYaw);

	// --- Route geometry and snapping --------------------------------------------------------

	struct FSnap
	{
		int32_t Polyline = -1;
		int32_t Segment = -1;
		double Distance = 0.0; // along the polyline from its first point
		double Gap = 0.0;      // from the query point to Point
		FVec2 Point;
		double Yaw = 0.0;      // direction of the polyline (its point order) at Point
	};

	// Polylines of every route, with a uniform grid so finding the nearest line is cheap.
	class FRouteGeometry
	{
	public:
		// Reports for a route that run against the reference direction only win if nothing running
		// with it is within this much more distance (the other track of the same street is ~3.5 m away).
		double WrongWayPenalty = 2000.0;

		// Points further than this from the origin are dropped (1000 km in centimetres): absurd
		// coordinates from a damaged file must not make the grid enormous.
		static constexpr double MaxCoordinate = 1e8;

		void Reset();

		// Layer groups polylines that can share a centreline (e.g. 0 = tram tracks, 1 = roads).
		// Repeated, non-finite and absurdly distant points are dropped; returns the polyline index,
		// or -1 if fewer than two points remain.
		int32_t AddPolyline(uint32_t RouteIndex, uint8_t Layer, const std::vector<FVec2>& Points);

		// Some feeds draw both directions of a line on one centreline. Wherever a polyline has an
		// opposite-direction polyline of the same layer within DetectRadius, its points move to the
		// right of its direction of travel by OffsetByLayer[Layer] (missing/0 = never), so each
		// direction gets its own track or lane, as in Hungary's right-hand traffic. Polylines that
		// already run on their own track are left alone. Call after the last AddPolyline, before Build.
		void SeparateSharedCenterlines(const std::vector<double>& OffsetByLayer, double DetectRadius);

		// Builds the snapping grid. Call once all polylines are final.
		void Build(double InCellSize);

		int32_t PolylineCount() const { return static_cast<int32_t>(Polylines.size()); }
		bool IsValidPolyline(int32_t Polyline) const { return Polyline >= 0 && Polyline < PolylineCount(); }
		uint32_t RouteOf(int32_t Polyline) const;
		uint8_t LayerOf(int32_t Polyline) const;
		const std::vector<FVec2>& PointsOf(int32_t Polyline) const;
		double LengthOf(int32_t Polyline) const;

		// Nearest point on any polyline of the route within MaxGap. With a reference yaw, polylines
		// running the other way are penalised by WrongWayPenalty (see above). False if none is in reach.
		bool Snap(uint32_t RouteIndex, const FVec2& Query, double MaxGap, bool bHasReference, double ReferenceYaw, FSnap& Out) const;

		// Nearest point on one polyline, at any distance.
		bool Project(int32_t Polyline, const FVec2& Query, FSnap& Out) const;

		// Point at a distance along a polyline, extended in a straight line beyond either end, and the
		// polyline's direction there.
		FVec2 PointAt(int32_t Polyline, double Distance, double* OutYaw = nullptr) const;

	private:
		struct FPolyline
		{
			uint32_t Route = 0;
			uint8_t Layer = 0;
			std::vector<FVec2> Points;
			std::vector<double> Cumulative; // distance from the first point to each point
		};

		struct FSegmentRef
		{
			int32_t Polyline = 0;
			int32_t Segment = 0;
		};

		static void Measure(FPolyline& Line);
		bool NearestOnSegment(int32_t Polyline, int32_t Segment, const FVec2& Query, FSnap& Out) const;

		std::vector<FPolyline> Polylines;
		std::vector<FSegmentRef> Segments;
		std::unordered_map<int64_t, std::vector<uint32_t>> Grid;
		double CellSize = 0.0;
	};

	// --- Moving along a line ----------------------------------------------------------------

	// Keeps a vehicle on its polyline between position reports: it travels along the line towards
	// the last reported position instead of cutting straight across corners.
	struct FTrackFollower
	{
		int32_t Polyline = -1;
		double Distance = 0.0; // current position along Polyline
		double Target = 0.0;   // reported position along Polyline
		double Speed = 0.0;    // along the line, distance units per second, >= 0
		int32_t Direction = 1; // +1 travels in the polyline's point order, -1 against it

		bool IsActive() const { return Polyline >= 0; }
		void Stop();
		void Advance(double DeltaSeconds);
	};

	enum class EFollow : uint8_t
	{
		Started,   // first report: placed on the line
		Continued, // same line, moving on towards the report
		HeldBack,  // the report was a little behind (GPS noise): waits instead of reversing
		Switched,  // hopped onto another polyline of the route that runs close by
		Jumped     // too far to travel plausibly: teleported to the report
	};

	struct FFollowLimits
	{
		double SwitchRadius = 2500.0; // furthest hop onto another polyline of the route
		double MaxBackward = 5000.0;  // reports further behind than this are believed, not ignored
		double MaxForward = 100000.0; // reports further ahead than this teleport instead of racing
	};

	// Feeds a new report: Snap = where it lands on Geometry, TravelYaw = the vehicle's direction of
	// travel (feed bearing, or its movement), SecondsToArrive = time to cover the gap (about the feed interval).
	EFollow UpdateFollower(const FRouteGeometry& Geometry, FTrackFollower& Follower, const FSnap& Snap,
		double TravelYaw, double SecondsToArrive, const FFollowLimits& Limits);

	// Where a rigid body whose two ends ride on the polyline at the two distances sits: on the chord
	// between them, facing from RearDistance to FrontDistance (how a carriage sits on its bogies in a curve).
	void ChordPose(const FRouteGeometry& Geometry, int32_t Polyline, double FrontDistance, double RearDistance, FVec2& OutCenter, double& OutYaw);

	// --- Meshes -----------------------------------------------------------------------------

	// Per point: the direction to its right (unit length at the ends, longer at bends so strips keep
	// their width - capped at twice the width on hairpins).
	std::vector<FVec2> RightMiters(const std::vector<FVec2>& Points);

	// A strip along a line, between two lateral offsets (positive = right of the direction of travel).
	struct FStripProfile
	{
		double Left = -50.0;
		double Right = 50.0;
		double TopZ = 1.0;
		double BottomZ = 0.0;
		bool bSides = false; // also build the two side walls down to BottomZ
	};

	// Appends the strip over one segment (points Segment and Segment + 1) to Out, upward-facing (and
	// outward-facing sides), with Origin subtracted so big coordinates stay precise as floats.
	// Winding as in CityMesh: (B - A) x (C - A) points out of the solid.
	void AppendStripSegment(const std::vector<FVec2>& Points, const std::vector<FVec2>& Miters, size_t Segment,
		const FStripProfile& Profile, double OriginX, double OriginY, CityMesh::FBuffer& Out);

	// Remembers segments by their quantised end points (either direction), so track shared by several
	// lines or shapes is built once.
	class FSegmentSet
	{
	public:
		explicit FSegmentSet(double InQuantum) : Quantum(InQuantum) {}
		// True the first time this segment (or its reverse) is seen.
		bool Insert(const FVec2& A, const FVec2& B);

	private:
		struct FHash
		{
			size_t operator()(const std::array<int64_t, 4>& Key) const;
		};
		double Quantum;
		std::unordered_set<std::array<int64_t, 4>, FHash> Seen;
	};

	// --- Sign text --------------------------------------------------------------------------

	// Hungarian o/u with double acute (not in the Latin-1 range many fonts stop at) as o/u with
	// umlaut, in UTF-8. Everything else is unchanged.
	std::string FoldDoubleAcute(const std::string& Utf8);

	// Greedy word wrap into lines of at most MaxChars characters (code points); longer words get a line of their own.
	std::vector<std::string> WrapWords(const std::string& Utf8, size_t MaxChars);
}
