using UnrealBuildTool;

public class BudapestSim : ModuleRules
{
	public BudapestSim(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
			"HTTP",
			"DeveloperSettings",
			"ProceduralMeshComponent",
			"EnhancedInput",
			"UMG",
			"Slate",
			"SlateCore"
		});
	}
}
