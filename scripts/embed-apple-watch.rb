#!/usr/bin/env ruby
# Adds apple-watch/Faceclaw.xcodeproj to the generated iOS project as a subproject
# and embeds its app in the phone app's Watch/ folder, or takes all that back out.
# See apple-watch-embed.cjs, which decides when to run this.
require 'xcodeproj'

PHASE_NAME = 'Embed Watch Content'
WATCH_TARGET = 'Faceclaw'

root = File.expand_path('..', __dir__)
watch_project_path = File.join(root, 'apple-watch/Faceclaw.xcodeproj')
project = Xcodeproj::Project.open(File.join(root, 'platforms/ios/faceclaw.xcodeproj'))
app = project.targets.find { |target| target.name == 'faceclaw' } or abort 'No faceclaw target in the iOS project'

def remove_embed(project, app, watch_project_path)
  app.copy_files_build_phases.select { |phase| phase.name == PHASE_NAME }.each do |phase|
    phase.files.to_a.each(&:remove_from_project)
    phase.remove_from_project
  end
  app.dependencies.select { |dependency| dependency.display_name == WATCH_TARGET }.each(&:remove_from_project)
  reference = project.reference_for_path(watch_project_path)
  return unless reference

  # Saving fails on any proxy still pointing at the subproject.
  project.objects.select { |object| object.isa == 'PBXContainerItemProxy' && object.container_portal == reference.uuid }
         .each(&:remove_from_project)
  entries = project.root_object.project_references
  entries.select { |entry| entry[:project_ref] == reference }.each do |entry|
    entry[:product_group].remove_from_project
    entries.delete(entry)
  end
  reference.remove_from_project
end

remove_embed(project, app, watch_project_path)

if ARGV[0] == 'embed'
  reference = project.main_group.new_file(watch_project_path)
  watch_target = Xcodeproj::Project.open(watch_project_path).targets.find { |target| target.name == WATCH_TARGET }
  app.add_dependency(watch_target)

  entry = project.root_object.project_references.find { |candidate| candidate[:project_ref] == reference }
  product = entry[:product_group].children.find { |child| child.path == "#{WATCH_TARGET}.app" } or abort 'The watch project has no app product'
  phase = app.new_copy_files_build_phase(PHASE_NAME)
  phase.symbol_dst_subfolder_spec = :products_directory
  phase.dst_path = '$(CONTENTS_FOLDER_PATH)/Watch'
  phase.add_file_reference(product).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

project.save
