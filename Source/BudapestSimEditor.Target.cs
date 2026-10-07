using UnrealBuildTool;
using System.Collections.Generic;

public class BudapestSimEditorTarget : TargetRules
{
	public BudapestSimEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("BudapestSim");
	}
}
