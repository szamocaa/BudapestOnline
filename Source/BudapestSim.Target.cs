using UnrealBuildTool;
using System.Collections.Generic;

public class BudapestSimTarget : TargetRules
{
	public BudapestSimTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("BudapestSim");
	}
}
